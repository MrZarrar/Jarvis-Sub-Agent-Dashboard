/**
 * @file assistant-actions/registry.js
 * @description The single source of truth for what the assistant can DO (Phase M,
 * §3.1). Every action is `{ name, description, params, risk, side, execute }`:
 *
 *   - `params`  JSON-schema-ish object ({ type:"object", properties, required }) -
 *               used both to validate input AND to generate each provider's
 *               tool/function-calling spec (bindings are generated FROM the
 *               registry, never hand-maintained per provider).
 *   - `risk`    "safe" | "confirm" | "typed" - mirrors the skills confirm model.
 *               The dispatcher (dispatcher.js) is the ONE place that enforces it.
 *   - `side`    "server" (executes in-process) | "client" (returned to the
 *               browser to execute - e.g. flipping the HUD; never runs here).
 *   - `execute(params, ctx)` server actions only; returns a short result object.
 *
 * Risk levels are chosen so Siri/voice/scheduled callers keep EXACTLY the agency
 * master-plan Phase D gave them (status/kill/steer/note/run-skill/briefing are
 * all `safe`); the genuinely new destructive powers (spawn a run, write a file,
 * create a schedule, run a shell command) are gated so voice can never fire them.
 * NEVER downgrade a risk to make a demo smoother (repo rule).
 *
 * @author Jarvis (Phase M1)
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { exec, execFile } = require("node:child_process");

const MAX_FILE_BYTES = 256 * 1024;
const MAX_OUTPUT_CHARS = 8_000;
const SHELL_TIMEOUT_MS = 60_000;
const PIN_REQUIRED = Object.freeze({ code: "PIN_REQUIRED" });

function canReadSensitive(ctx) {
  return ctx?.access?.includeSensitive === true;
}

function searchNotesForAssistant(q, ctx) {
  const notes = require("../notes");
  const query = String(q || "").trim() || null;
  const includeSensitive = canReadSensitive(ctx);
  if (!includeSensitive) {
    const allMatches = notes.listNotes({
      q: query,
      limit: Number.MAX_SAFE_INTEGER,
      includeSensitive: true,
    });
    if (allMatches.some((note) => note.sensitive)) return PIN_REQUIRED;
  }
  return notes.listNotes({ q: query, limit: 20, includeSensitive });
}

function truncate(s, n = MAX_OUTPUT_CHARS) {
  const str = String(s == null ? "" : s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

// ── File-access allowlist (Settings-managed; empty by default) ──────────────
// "Given access" is literal: nothing on the filesystem is reachable until the
// user adds a root in Settings. Roots are stored as a JSON array in app_settings
// under `assistant_allowed_roots`. Reads never throw; a bad value = no access.
const ROOTS_KEY = "assistant_allowed_roots";

// ── Autonomy (the `claude_agent` delegate; Settings-managed, off by default) ──
// "off"  → the agent tool refuses (mini-Jarvis stays text-only).
// "ask"  → risk "confirm": Gemini proposes it, the human taps once in the popup.
// "auto" → risk "safe": Gemini (and even Siri/scheduled) fire it inline, no tap.
// The user opts into the level in Settings; nothing here is silently weakened.
const AUTONOMY_KEY = "assistant_autonomy";

// ── Browse (Phase Z, computer use); Settings-managed opt-in ─────────────────
// The `browse` action acts on the network in the user's name, so it is risk
// "confirm" by default (one tap in the popup). A Settings opt-in marks read-only
// navigation "safe" so Tabby/Siri can drive it inline. Stored as a "true"/"false"
// string in app_settings under `assistant_browse_safe`.
const BROWSE_KEY = "assistant_browse_safe";

function browseSafe() {
  try {
    const { stmts } = require("../../db");
    const row = stmts.getSetting.get(BROWSE_KEY);
    return !!(row && String(row.value).trim() === "true");
  } catch {
    return false;
  }
}

// ── Computer use (Phase Z, Tier 2); Settings-managed opt-in ─────────────────
// The `computer_use` action drives the REAL Mac desktop (clicks/keystrokes) -
// stronger than `browse`'s read-only navigation, so it gets its own opt-in.
// "confirm" by default (one tap); a Settings opt-in marks it "safe" so
// Tabby/Siri can drive it inline. Stored as a "true"/"false" string in
// app_settings under `assistant_computer_use_safe`.
const COMPUTER_USE_KEY = "assistant_computer_use_safe";

// ── Legacy Phase-Z surfaces (retired in Phase AF) ───────────────────────────
// The home-rolled browse/computer-use streamers are parked, not deleted, for
// one release: LEGACY_SURFACES=1 resurrects them (server actions here, client
// routes via the same env at build time). Replacements: RustDesk over the
// tailnet for live screen mirroring (SETUP.md "Remote screen"), ChatGPT Work
// for agentic computer use, and `open_browser` for opening pages on the Mac.
const legacySurfaces = () => process.env.LEGACY_SURFACES === "1";
const RETIRED_MSG =
  "This surface was retired - use RustDesk for screen mirroring (see SETUP.md " +
  "→ Remote screen) or ChatGPT Work for agentic computer use. Start the " +
  "server with LEGACY_SURFACES=1 to resurrect it.";

function computerUseSafe() {
  try {
    const { stmts } = require("../../db");
    const row = stmts.getSetting.get(COMPUTER_USE_KEY);
    return !!(row && String(row.value).trim() === "true");
  } catch {
    return false;
  }
}

function autonomyMode() {
  try {
    const { stmts } = require("../../db");
    const row = stmts.getSetting.get(AUTONOMY_KEY);
    const v = row && typeof row.value === "string" ? row.value.trim() : "";
    return v === "auto" || v === "ask" ? v : "off";
  } catch {
    return "off";
  }
}

function allowedRoots() {
  try {
    const { stmts } = require("../../db");
    const row = stmts.getSetting.get(ROOTS_KEY);
    if (!row || typeof row.value !== "string" || !row.value.trim()) return [];
    const arr = JSON.parse(row.value);
    return Array.isArray(arr)
      ? arr.filter((r) => typeof r === "string" && r.trim()).map(untilde)
      : [];
  } catch {
    return [];
  }
}

function untilde(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve `p` and confirm it is inside an allowed root (path-boundary aware, so
 *  `/a/bc` is NOT considered inside `/a/b`). Throws EACCES otherwise. */
function resolveInRoots(p) {
  const roots = allowedRoots();
  if (!roots.length) {
    const err = new Error("no file roots are allowed - grant one in Settings first");
    err.code = "EACCES";
    throw err;
  }
  const abs = path.resolve(untilde(String(p || "")));
  const ok = roots.some((root) => {
    const r = path.resolve(root);
    return abs === r || abs.startsWith(r + path.sep);
  });
  if (!ok) {
    const err = new Error(`path is outside every allowed root: ${abs}`);
    err.code = "EACCES";
    throw err;
  }
  return abs;
}

// ── Actions ─────────────────────────────────────────────────────────────────

const ACTIONS = [
  {
    name: "get_status",
    description: "Report live dashboard runs, active sessions, and agents waiting on the user.",
    params: { type: "object", properties: {} },
    risk: "safe",
    side: "server",
    execute() {
      const runs = require("../run-spawner");
      const live = runs.listRuns().filter((r) => r.status === "running" || r.status === "spawning");
      const waitingRuns = live.filter((r) => (r.pendingPermissions || []).length > 0).length;
      let activeSessions = 0;
      let waitingAgents = 0;
      let workingAgents = 0;
      try {
        const db = require("../../db").db;
        activeSessions = db
          .prepare("SELECT COUNT(*) AS c FROM sessions WHERE status = 'active'")
          .get().c;
        waitingAgents = db
          .prepare("SELECT COUNT(*) AS c FROM agents WHERE status = 'waiting'")
          .get().c;
        workingAgents = db
          .prepare("SELECT COUNT(*) AS c FROM agents WHERE status = 'working'")
          .get().c;
      } catch {
        /* DB not ready */
      }
      return {
        liveRuns: live.length,
        waitingRuns,
        activeSessions,
        workingAgents,
        waitingAgents,
        runs: live.map((r) => ({ id: r.id, cwd: r.cwd || null, status: r.status })),
      };
    },
  },
  {
    name: "kill_run",
    description: "Stop a running dashboard run by id, or all of them.",
    params: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run id or 8-char prefix. Omit with all=true." },
        all: { type: "boolean", description: "Stop every live run." },
      },
    },
    risk: "safe",
    side: "server",
    execute({ runId, all }) {
      const runs = require("../run-spawner");
      const live = runs.listRuns().filter((r) => r.status === "running" || r.status === "spawning");
      if (all) {
        let killed = 0;
        for (const r of live) if (runs.killRun(r.id)) killed++;
        return { killed };
      }
      const target = matchRun(live, runId);
      if (!target) throw actionErr("ENOTARGET", "no matching live run");
      const ok = runs.killRun(target.id);
      return { killed: ok ? 1 : 0, id: target.id };
    },
  },
  {
    name: "steer_run",
    description: "Send a follow-up message into a live conversation run.",
    params: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run id or 8-char prefix." },
        message: { type: "string", description: "The message to send into the run." },
      },
      required: ["message"],
    },
    risk: "safe",
    side: "server",
    execute({ runId, message }) {
      const runs = require("../run-spawner");
      const msg = String(message || "").trim();
      if (!msg) throw actionErr("EBADINPUT", "message is required");
      const convRuns = runs
        .listRuns()
        .filter(
          (r) => (r.status === "running" || r.status === "spawning") && r.mode === "conversation"
        );
      const target = matchRun(convRuns, runId);
      if (!target) throw actionErr("ENOTARGET", "no matching live conversation run");
      runs.sendInput(target.id, msg);
      return { id: target.id };
    },
  },
  {
    name: "spawn_run",
    description: "Spawn a new agent (Claude/Gemini) run to do a task.",
    params: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the agent should do." },
        cwd: { type: "string", description: "Working directory (optional)." },
        provider: { type: "string", description: "claude | gemini (optional)." },
      },
      required: ["prompt"],
    },
    risk: "confirm",
    side: "server",
    execute({ prompt, cwd, provider }) {
      const runs = require("../run-spawner");
      const handle = runs.spawnRun({
        prompt: String(prompt || ""),
        mode: "headless",
        cwd: cwd ? untilde(String(cwd)) : undefined,
        provider: typeof provider === "string" ? provider : undefined,
      });
      return { id: handle.id };
    },
  },
  {
    name: "write_note",
    description: "Capture a note / brain dump to the assistant inbox.",
    params: {
      type: "object",
      properties: { text: { type: "string", description: "The note text." } },
      required: ["text"],
    },
    risk: "safe",
    side: "server",
    execute({ text }, ctx) {
      const { randomUUID } = require("node:crypto");
      const db = require("../../db").db;
      const body = String(text || "").trim();
      if (!body) throw actionErr("EBADINPUT", "text is required");
      const id = randomUUID();
      db.prepare("INSERT INTO assistant_captures (id, text, source) VALUES (?, ?, ?)").run(
        id,
        body,
        (ctx && ctx.source) || null
      );
      return { id };
    },
  },
  {
    name: "search_notes",
    description: "Search the user's notes and return matching titles.",
    params: {
      type: "object",
      properties: { q: { type: "string", description: "Search query." } },
      required: ["q"],
    },
    risk: "safe",
    side: "server",
    execute({ q }, ctx) {
      const rows = searchNotesForAssistant(q, ctx);
      if (rows === PIN_REQUIRED) return PIN_REQUIRED;
      return { results: rows.map((n) => ({ id: n.id, title: n.title })) };
    },
  },
  // ── Knowledge vault (Phase S). All safe: read-only traversal, or writes that
  // the vault lib itself confines to inbox/ and agent/ (never overwrites a
  // human note - always a fresh file). Same trust level as write_note above.
  {
    name: "vault_search",
    description: "Search the knowledge vault (notes, run/chat memories) by keyword.",
    params: {
      type: "object",
      properties: { q: { type: "string", description: "Search query." } },
      required: ["q"],
    },
    risk: "safe",
    side: "server",
    execute({ q }, ctx) {
      const vault = require("../vault");
      const rows = searchNotesForAssistant(q, ctx);
      if (rows === PIN_REQUIRED) return PIN_REQUIRED;
      return {
        results: rows.map((n) => ({ id: n.id, title: n.title, type: vault.nodeType(n.path) })),
      };
    },
  },
  {
    name: "vault_read",
    description: "Read one vault node: its markdown body plus outgoing links and backlinks.",
    params: {
      type: "object",
      properties: { id: { type: "string", description: "Vault node id." } },
      required: ["id"],
    },
    risk: "safe",
    side: "server",
    execute({ id }, ctx) {
      const vault = require("../vault");
      const noteId = String(id || "");
      const includeSensitive = canReadSensitive(ctx);
      const n = vault.node(noteId, { includeSensitive });
      if (!n && !includeSensitive) {
        const notes = require("../notes");
        const lockedMetadata = notes
          .listNotes({ includeSensitive: true, limit: Number.MAX_SAFE_INTEGER })
          .find((note) => note.id === noteId);
        if (lockedMetadata?.sensitive) return PIN_REQUIRED;
      }
      if (!n) throw actionErr("ENOTFOUND", "vault node not found");
      return {
        id: n.id,
        title: n.title,
        type: n.nodeType,
        body: truncate(n.body, 6000),
        outgoing: n.outgoing,
        backlinks: n.backlinks,
      };
    },
  },
  {
    name: "vault_write",
    description:
      "Write a NEW note into the vault's inbox/ or agent/ area (never overwrites existing notes).",
    params: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title." },
        body: { type: "string", description: "Markdown body; [[wikilinks]] become graph edges." },
        folder: {
          type: "string",
          description: 'Target folder: "inbox" (default) or an "agent/..." subfolder.',
        },
      },
      required: ["title", "body"],
    },
    risk: "safe",
    side: "server",
    execute({ title, body, folder }) {
      const vault = require("../vault");
      const note = vault.writeVaultFile({
        folder: typeof folder === "string" && folder.trim() ? folder.trim() : "inbox",
        title: String(title || "").trim(),
        body: String(body || ""),
        source: "agent",
      });
      return { id: note.id, path: note.path };
    },
  },
  {
    name: "vault_append_fact",
    description:
      "Append a durable fact to a confirmed existing person or reference node. Search first and use the canonical full name; ask when the target is ambiguous.",
    params: {
      type: "object",
      properties: {
        name: { type: "string", description: "Canonical node or person name." },
        fact: { type: "string", description: "The fact as one short line." },
        create: {
          type: "boolean",
          description: "Create a people node when a full name has no match (default true).",
        },
      },
      required: ["name", "fact"],
    },
    risk: "safe",
    side: "server",
    execute({ name, fact, create }) {
      const notes = require("../notes");
      const vault = require("../vault");
      const wanted = String(name || "").trim();
      if (!wanted) throw actionErr("EINVAL", "name is required");
      const exactId = vault.resolveKey(vault.normalizeKey(wanted));
      const rows = notes.listNotes({ q: wanted, limit: 10 });
      let target = exactId ? notes.getNote(exactId) : null;
      const candidates = rows.filter((row) =>
        ["person", "reference"].includes(vault.nodeType(row.path))
      );
      if (!target && candidates.length) {
        throw actionErr(
          "EAMBIGUOUS",
          `ambiguous vault target "${wanted}"; ask the user to choose: ${candidates
            .map((row) => row.title)
            .join(", ")}`
        );
      }
      if (!target && create !== false) {
        if (wanted.split(/\s+/).length < 2) {
          throw actionErr(
            "EAMBIGUOUS",
            `"${wanted}" is not a full name; ask for the person's full name before creating a node`
          );
        }
        target = vault.writeVaultFile({
          folder: "people",
          title: wanted,
          tags: ["people"],
          source: "engine",
          body: "",
        });
      }
      if (!target) throw actionErr("ENOTFOUND", `no vault node for "${wanted}"`);
      const result = vault.appendFact(target.id, String(fact || ""));
      return { id: target.id, title: target.title, path: result.path, added: result.added };
    },
  },
  {
    name: "vault_backlinks",
    description: "List the vault nodes that link TO a given node.",
    params: {
      type: "object",
      properties: { id: { type: "string", description: "Vault node id." } },
      required: ["id"],
    },
    risk: "safe",
    side: "server",
    execute({ id }) {
      const vault = require("../vault");
      const n = vault.node(String(id || ""));
      if (!n) throw actionErr("ENOTFOUND", "vault node not found");
      return { backlinks: n.backlinks };
    },
  },
  {
    name: "vault_neighbors",
    description: "List a vault node's direct neighborhood (links out and in).",
    params: {
      type: "object",
      properties: { id: { type: "string", description: "Vault node id." } },
      required: ["id"],
    },
    risk: "safe",
    side: "server",
    execute({ id }) {
      const vault = require("../vault");
      const n = vault.node(String(id || ""));
      if (!n) throw actionErr("ENOTFOUND", "vault node not found");
      return {
        outgoing: n.outgoing.filter((o) => o.resolved),
        incoming: n.backlinks,
      };
    },
  },
  {
    name: "vault_path",
    description: "Find the shortest chain of linked vault nodes connecting two node ids.",
    params: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start node id." },
        to: { type: "string", description: "End node id." },
      },
      required: ["from", "to"],
    },
    risk: "safe",
    side: "server",
    execute({ from, to }) {
      const vault = require("../vault");
      const ids = vault.pathBetween(String(from || ""), String(to || ""));
      if (!ids) return { path: null };
      return {
        path: ids
          .map((id) => vault.node(id))
          .filter(Boolean)
          .map((n) => ({ id: n.id, title: n.title, type: n.nodeType })),
      };
    },
  },
  {
    name: "run_skill",
    description: "Run a saved skill by name. A skill's own confirm level still applies.",
    params: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name (substring ok)." } },
      required: ["name"],
    },
    // safe: the per-skill confirm gate (engine.runSkill) is the real authority.
    risk: "safe",
    side: "server",
    execute({ name }, ctx) {
      const store = require("../skills/store");
      const engine = require("../skills/engine");
      const needle = String(name || "")
        .trim()
        .toLowerCase();
      if (!needle) throw actionErr("EBADINPUT", "name is required");
      let skills = [];
      try {
        skills = store.listSkills();
      } catch {
        skills = [];
      }
      const match =
        skills.find((s) => s.name.toLowerCase() === needle) ||
        skills.find((s) => s.name.toLowerCase().includes(needle));
      if (!match) throw actionErr("ENOTFOUND", `no skill named "${name}"`);
      // Assistant-initiated skill runs (typed OR spoken) are treated like voice:
      // engine.runSkill only lets a `confirm: none` skill fire this way. A typed
      // "run skill X" in the popup is NOT a tap on that skill's Run button, so we
      // must NOT map it to "manual" (which would bypass the tap gate). A confirm:
      // tap/typed skill is run from the Skills page's own confirm flow, not here.
      const run = engine.runSkill({ skillId: match.id, params: {}, trigger: "voice" });
      return { skill: match.id, name: match.name, runId: run.id };
    },
  },
  {
    name: "run_briefing",
    description: "Compose a morning or evening briefing and return it.",
    params: {
      type: "object",
      properties: { kind: { type: "string", enum: ["morning", "evening"] } },
      required: ["kind"],
    },
    risk: "safe",
    side: "server",
    async execute({ kind }) {
      const briefings = require("../briefings");
      const k = kind === "evening" ? "evening" : "morning";
      const row = await briefings.runBriefing({ kind: k, trigger: "assistant" });
      return { id: row.id, kind: k, text: truncate(row.text, 2000) };
    },
  },
  {
    name: "create_schedule",
    description: "Schedule a prompt to spawn a new run at a future time (one-off).",
    params: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to run when it fires." },
        at: { type: "string", description: "ISO timestamp to fire at." },
        label: { type: "string", description: "A short label (optional)." },
      },
      required: ["prompt", "at"],
    },
    risk: "confirm",
    side: "server",
    execute({ prompt, at, label }) {
      const scheduler = require("../scheduler");
      const row = scheduler.createSchedule({
        prompt: String(prompt || ""),
        label: label ? String(label) : null,
        triggerKind: "at",
        fireAt: String(at || ""),
      });
      return { id: row.id };
    },
  },
  {
    name: "github_overview",
    description: "Return the cached GitHub overview (open PRs, review requests, failing checks).",
    params: { type: "object", properties: {} },
    risk: "safe",
    side: "server",
    execute() {
      const gh = require("../github/service");
      const overview = gh.getCached();
      return { overview: overview || null };
    },
  },
  {
    name: "list_dir",
    description: "List a directory's entries. Only works inside a Settings-allowed root.",
    params: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path." } },
      required: ["path"],
    },
    risk: "safe",
    side: "server",
    execute({ path: p }) {
      const abs = resolveInRoots(p);
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      return {
        path: abs,
        entries: entries.slice(0, 500).map((e) => ({ name: e.name, dir: e.isDirectory() })),
      };
    },
  },
  {
    name: "read_file",
    description: "Read a text file. Only works inside a Settings-allowed root.",
    params: {
      type: "object",
      properties: { path: { type: "string", description: "File path." } },
      required: ["path"],
    },
    risk: "safe",
    side: "server",
    execute({ path: p }) {
      const abs = resolveInRoots(p);
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES)
        throw actionErr("ETOOBIG", `file is larger than ${MAX_FILE_BYTES} bytes`);
      return { path: abs, content: truncate(fs.readFileSync(abs, "utf8")) };
    },
  },
  {
    name: "write_file",
    description: "Write a text file. Only works inside a Settings-allowed root.",
    params: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path." },
        content: { type: "string", description: "File contents." },
      },
      required: ["path", "content"],
    },
    risk: "confirm",
    side: "server",
    execute({ path: p, content }) {
      const abs = resolveInRoots(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content == null ? "" : content), "utf8");
      return { path: abs, bytes: Buffer.byteLength(String(content || "")) };
    },
  },
  {
    name: "shell",
    description:
      "Run a shell command on the user's machine. High risk - requires typed confirmation.",
    params: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        cwd: { type: "string", description: "Working directory (optional)." },
      },
      required: ["command"],
    },
    risk: "typed",
    side: "server",
    execute({ command, cwd }) {
      const cmd = String(command || "").trim();
      if (!cmd) throw actionErr("EBADINPUT", "command is required");
      return new Promise((resolve, reject) => {
        exec(
          cmd,
          {
            cwd: cwd ? untilde(String(cwd)) : os.homedir(),
            timeout: SHELL_TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
          },
          (err, stdout, stderr) => {
            if (err) return reject(actionErr("ESHELL", truncate(stderr || err.message, 2000)));
            resolve({ output: truncate(stdout).trim() || "(no output)" });
          }
        );
      });
    },
  },
  {
    // The one tool that turns a text-only brain into a full agent: it hands the
    // task to a headless Claude Code agent (web + agent-reach skill + files +
    // shell). Risk is dynamic - see AUTONOMY_KEY. Off by default; enable in
    // Settings → Assistant Access.
    name: "claude_agent",
    description:
      "Delegate a task to Claude - a full autonomous agent with live internet access (web search + fetching pages), the agent-reach skill for social/dev/web platforms (Twitter/X, Reddit, YouTube, GitHub, xiaohongshu, Bilibili, RSS, arbitrary URLs), and file/shell tools on this machine. Use this whenever the answer needs the internet, up-to-date facts, deep multi-step research, or anything you cannot do yourself. Give a clear, self-contained instruction; Claude returns the finished result.",
    params: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "A clear, self-contained instruction for Claude to carry out.",
        },
      },
      required: ["task"],
    },
    get risk() {
      return autonomyMode() === "auto" ? "safe" : "confirm";
    },
    side: "server",
    async execute({ task }) {
      if (autonomyMode() === "off") {
        throw actionErr(
          "EDISABLED",
          "The Claude agent is off - enable it in Settings → Assistant Access."
        );
      }
      const claude = require("../providers/claude");
      const text = await claude.runAgentTask(String(task || ""), {
        hint: "Use the agent-reach skill for social/web-platform lookups; keep the answer concise.",
      });
      return { text: truncate(text, 6000) || "(the agent returned no text)" };
    },
  },
  {
    // Phase Z, Tier 1: open a headless browser, search/navigate, and stream a
    // screenshot of every step to the dashboard (browse_frame over the WS) so
    // the user watches from their phone. Risk is dynamic per the Settings opt-in
    // (browseSafe): "confirm" by default, "safe" when the user allows read-only
    // navigation to fire inline. Deep-links the reply to the /browse live view.
    name: "browse",
    description:
      'Open a HEADLESS browser and stream screenshots to the dashboard\'s live browse view - a read-only picture the user can watch REMOTELY (e.g. on their phone away from the Mac). Cannot be clicked, and may hit bot/CAPTCHA checks. If the user is at their Mac and wants to actually interact, prefer `open_browser`. Use for "show me on my phone". Give a `query` to search or a `url` to open.',
    params: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        url: { type: "string", description: "A URL to open directly (instead of a search)." },
      },
    },
    get risk() {
      return browseSafe() ? "safe" : "confirm";
    },
    side: "server",
    async execute({ query, url }) {
      if (!legacySurfaces()) throw actionErr("ERETIRED", RETIRED_MSG);
      const browser = require("../browser");
      const out = await browser.browse({ query, url });
      return { ...out, view: "/browse" };
    },
  },
  {
    // Phase Z, Tier 0: open a URL/search in the user's REAL browser on their Mac
    // (`open <url>`) - their normal window, logged-in session, fully interactive,
    // no bot checks. Only useful when the user is AT the Mac (it opens there, and
    // streams nothing to the dashboard/phone). Same browse-safe opt-in gate.
    name: "open_browser",
    description:
      'Open a URL or web search in the user\'s REAL browser on their Mac - their normal browser window, logged-in session, fully interactive (they can click and scroll), no bot/CAPTCHA checks. Use when the user is at their Mac and wants to actually use the page, or says "open ... in my browser". Opens on the Mac itself; streams nothing to the dashboard. Give a `query` to search or a `url` to open.',
    params: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        url: { type: "string", description: "A URL to open directly (instead of a search)." },
      },
    },
    get risk() {
      return browseSafe() ? "safe" : "confirm";
    },
    side: "server",
    execute({ query, url }) {
      if (process.platform !== "darwin") {
        throw actionErr("EPLATFORM", "opening the Mac's browser only works on macOS");
      }
      const target = require("../browser").toUrl(query, url);
      if (!target) throw actionErr("EBADINPUT", "open_browser needs a query or a url");
      return new Promise((resolve, reject) => {
        // execFile (not a shell) with the URL as a single arg - no injection.
        execFile("open", [target], (err) => {
          if (err) return reject(actionErr("EOPEN", err.message));
          resolve({ opened: target });
        });
      });
    },
  },
  {
    // Phase Z, Tier 2: drive the REAL Mac desktop - clicks, keystrokes, and
    // keypresses via macOS "System Events" UI scripting - screenshotting after
    // every step and streaming it to the dashboard's live Computer Use view
    // (computer_use_frame over the WS), so the user watches from their phone.
    // This actually controls the desktop (unlike `browse`'s headless,
    // browser-only view), so it is gated separately and more conservatively:
    // risk is dynamic per its own Settings opt-in (computerUseSafe).
    name: "computer_use",
    description:
      'Take a screenshot of the Mac\'s REAL screen, or run a short bounded sequence of clicks/keystrokes/keypresses on it - screenshotting after each step and streaming it to the dashboard\'s live Computer Use view (the user can watch from their phone). This actually controls the desktop mouse/keyboard, unlike `browse` (a headless, browser-only view). Give up to 10 `steps`: {"type":"click","x":..,"y":..} | {"type":"type","text":".."} | {"type":"key","key":"return|tab|escape|.."} | {"type":"screenshot"}. Omit steps to just take a screenshot ("show me my screen").',
    params: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description:
            'Up to 10 steps: {type:"click",x,y} | {type:"type",text} | {type:"key",key} | {type:"screenshot"}.',
          items: { type: "object" },
        },
      },
    },
    get risk() {
      return computerUseSafe() ? "safe" : "confirm";
    },
    side: "server",
    async execute({ steps }) {
      if (!legacySurfaces()) throw actionErr("ERETIRED", RETIRED_MSG);
      const computerUse = require("../computer-use");
      const out = await computerUse.computerUse({ steps });
      return { ...out, view: "/computer-use" };
    },
  },
  // ── Client-side actions: validated + gated + logged here, but EXECUTED by the
  // browser (returned in the ask response's actions[]). No server `execute`. ──
  {
    name: "set_hud_mode",
    description: "Switch the HUD theme/persona: jarvis, ultron, or auto.",
    params: {
      type: "object",
      properties: { mode: { type: "string", enum: ["jarvis", "ultron", "auto"] } },
      required: ["mode"],
    },
    risk: "safe",
    side: "client",
  },
  {
    name: "navigate",
    description: "Navigate the dashboard to a route.",
    params: {
      type: "object",
      properties: { to: { type: "string", description: "A dashboard path, e.g. /run/<id>." } },
      required: ["to"],
    },
    risk: "safe",
    side: "client",
  },
  {
    name: "open_panel",
    description: "Open a panel in the assistant popup (e.g. inbox, providers).",
    params: {
      type: "object",
      properties: { panel: { type: "string", description: "Panel name." } },
      required: ["panel"],
    },
    risk: "safe",
    side: "client",
  },
];

const BY_NAME = new Map(ACTIONS.map((a) => [a.name, a]));

function get(name) {
  return BY_NAME.get(name) || null;
}
function list() {
  return ACTIONS.slice();
}

/** Match a run by full id / 8-char prefix, or the sole live run when unambiguous. */
function matchRun(pool, runId) {
  if (!pool.length) return null;
  if (runId) {
    const needle = String(runId).toLowerCase();
    const byId = pool.find((r) => {
      const id = String(r.id).toLowerCase();
      return id === needle || id.startsWith(needle) || needle.includes(id.slice(0, 8));
    });
    if (byId) return byId;
    return null;
  }
  return pool.length === 1 ? pool[0] : null;
}

function actionErr(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Generate Gemini functionDeclarations from the registry (bindings are derived,
 *  not hand-kept). Any provider that speaks the OpenAI/Gemini JSON-schema tool
 *  shape can reuse this. */
function geminiToolSpecs() {
  const off = autonomyMode() === "off";
  return ACTIONS.filter((a) => !(off && a.name === "claude_agent")).map((a) => ({
    name: a.name,
    description: a.description,
    parameters: a.params && a.params.properties ? a.params : { type: "object", properties: {} },
  }));
}

module.exports = {
  PIN_REQUIRED,
  list,
  get,
  geminiToolSpecs,
  allowedRoots,
  ROOTS_KEY,
  resolveInRoots,
  AUTONOMY_KEY,
  autonomyMode,
  BROWSE_KEY,
  browseSafe,
  COMPUTER_USE_KEY,
  computerUseSafe,
};
