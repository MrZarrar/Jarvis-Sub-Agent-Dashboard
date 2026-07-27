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
const { execFile } = require("node:child_process");

const MAX_FILE_BYTES = 256 * 1024;
const MAX_OUTPUT_CHARS = 8_000;
const SHELL_TIMEOUT_MS = 60_000;

function truncate(s, n = MAX_OUTPUT_CHARS) {
  const str = String(s == null ? "" : s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

// ── File-access allowlist (Settings-managed; empty by default) ──────────────
// "Given access" is literal: nothing on the filesystem is reachable until the
// user adds a root in Settings. Roots are stored as a JSON array in app_settings
// under `assistant_allowed_roots`. Reads never throw; a bad value = no access.
const ROOTS_KEY = "assistant_allowed_roots";

// ── Autonomy (legacy `claude_agent` name; now mission-backed) ───────────────
// "off"  → durable delegation is disabled.
// "ask"  → risk "confirm": the human approves mission creation.
// "auto" → risk "safe": trusted front doors may create a mission inline.
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

// ── Legacy headless-browse surface (retired in Phase AF) ────────────────────
// LEGACY_SURFACES=1 resurrects the old streamed headless browser for one
// release. Real-browser opening and gated Mac computer use remain active.
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
      const missions = require("../missions").listMissions();
      const activeMissions = missions.filter((mission) =>
        ["queued", "planning", "delegated", "running", "waiting_approval", "blocked"].includes(
          mission.status
        )
      );
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
        activeMissions: activeMissions.length,
        waitingApprovals: activeMissions.filter((mission) => mission.status === "waiting_approval")
          .length,
        missions: activeMissions.map((mission) => ({
          id: mission.id,
          title: mission.title,
          status: mission.status,
        })),
        runs: live.map((r) => ({ id: r.id, cwd: r.cwd || null, status: r.status })),
      };
    },
  },
  {
    name: "kill_run",
    description:
      "Interrupt an active Jarvis mission by id, or all active missions. The legacy action name is retained for saved commands.",
    params: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run id or 8-char prefix. Omit with all=true." },
        all: { type: "boolean", description: "Stop every live run." },
      },
    },
    risk: "safe",
    side: "server",
    async execute({ runId, all }) {
      const missions = require("../missions");
      const live = missions.listMissions().filter((mission) => mission.controls.interrupt);
      if (all) {
        let killed = 0;
        for (const mission of live) {
          await missions.interruptMission(mission.id);
          killed++;
        }
        return { killed };
      }
      const target = matchRun(live, runId);
      if (!target) throw actionErr("ENOTARGET", "no matching active mission");
      await missions.interruptMission(target.id);
      return { killed: 1, id: target.id, missionId: target.id };
    },
  },
  {
    name: "steer_run",
    description:
      "Steer or continue a Jarvis mission. The legacy action name is retained for saved commands.",
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
    async execute({ runId, message }) {
      const missions = require("../missions");
      const msg = String(message || "").trim();
      if (!msg) throw actionErr("EBADINPUT", "message is required");
      const steerable = missions.listMissions().filter((mission) => mission.controls.steer);
      const target = matchRun(steerable, runId);
      if (!target) throw actionErr("ENOTARGET", "no matching steerable mission");
      await missions.steerMission(target.id, msg);
      return { id: target.id, missionId: target.id };
    },
  },
  {
    name: "spawn_run",
    description: "Create a provider-neutral Jarvis mission to do a durable task.",
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
    async execute({ prompt, cwd, provider }) {
      const missions = require("../missions");
      const requested = typeof provider === "string" ? provider : "";
      const mission = await missions.createMission({
        prompt: String(prompt || ""),
        domain:
          requested === "claude"
            ? "development"
            : requested.startsWith("gemini")
              ? "generic"
              : "personal",
        interaction: requested.startsWith("gemini") ? "bounded_action" : "durable_mission",
        workspace: cwd ? untilde(String(cwd)) : undefined,
        requestedProvider: requested.startsWith("gemini") ? "gemini" : undefined,
        origin: "api",
      });
      return { id: mission.id, missionId: mission.id, view: `/missions/${mission.id}` };
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
    execute({ q }) {
      const notes = require("../notes");
      const rows = notes.listNotes({ q: String(q || "").trim() || null, limit: 20 });
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
    execute({ q }) {
      const notes = require("../notes");
      const vault = require("../vault");
      const rows = notes.listNotes({ q: String(q || "").trim() || null, limit: 20 });
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
    execute({ id }) {
      const vault = require("../vault");
      const n = vault.node(String(id || ""));
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
      "Append a durable fact to a confirmed existing person/topic node. Search first and use the canonical full name. If the name or target is ambiguous, ask the user instead of calling this tool. A new people/ node is created only when a full name is supplied and no existing title or alias matches. For events/diary use vault_write instead.",
    params: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Node/person name, e.g. "Volkan".' },
        fact: {
          type: "string",
          description: "The fact as one short line, e.g. 'fav word: \"actually\"'.",
        },
        create: {
          type: "boolean",
          description: "Create a new people/ node if none matches (default true).",
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
      let target = exactId ? rows.find((r) => r.id === exactId) || notes.getNote(exactId) : null;
      const candidates = rows.filter((r) =>
        ["person", "reference"].includes(vault.nodeType(r.path))
      );
      if (!target && candidates.length) {
        const err = actionErr(
          "EAMBIGUOUS",
          `ambiguous vault target "${wanted}"; ask the user to choose: ${candidates.map((r) => r.title).join(", ")}`
        );
        throw err;
      }
      if (!target && create !== false) {
        if (wanted.split(/\s+/).length < 2) {
          throw actionErr(
            "EAMBIGUOUS",
            `"${wanted}" is not a full name; ask the user for the person's full name before creating a node`
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
      const res = vault.appendFact(target.id, String(fact || ""));
      return { id: target.id, title: target.title, path: res.path, added: res.added };
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
  // ── Project repo access (Phase T4). All safe/read-only: a project's
  // repo_path is only known because the user already registered that project
  // in the dashboard, so these skip the generic assistant_allowed_roots gate
  // (same reasoning as vault_write's own inbox/agent-only guardrail above -
  // the project registration IS the trust boundary).
  {
    name: "project_list_files",
    description:
      "List files in a project's repo on disk (git-tracked + untracked, gitignore-respected), optionally scoped to a subpath.",
    params: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id." },
        subpath: {
          type: "string",
          description: "Subdirectory to scope the listing to (optional).",
        },
      },
      required: ["projectId"],
    },
    risk: "safe",
    side: "server",
    async execute({ projectId, subpath }) {
      const projectFiles = require("../project-files");
      const files = await projectFiles.listProjectFiles(
        String(projectId || ""),
        subpath ? String(subpath) : ""
      );
      return { files };
    },
  },
  {
    name: "project_read_file",
    description: "Read one file's contents from a project's repo on disk (utf8, capped at 2MB).",
    params: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id." },
        path: { type: "string", description: "File path, relative to the repo root." },
      },
      required: ["projectId", "path"],
    },
    risk: "safe",
    side: "server",
    execute({ projectId, path: p }) {
      const projectFiles = require("../project-files");
      const content = projectFiles.readProjectFile(String(projectId || ""), String(p || ""));
      return { path: p, content: truncate(content) };
    },
  },
  {
    name: "project_codequery",
    description:
      "Run graphify's query CLI against a project's repo: `query` (search symbols), `explain` (describe a symbol), `path` (dependency path between two symbols), `affected` (blast radius of a change).",
    params: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id." },
        subcommand: { type: "string", description: "One of: query, explain, path, affected." },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Extra CLI args (symbol names, etc.).",
        },
      },
      required: ["projectId", "subcommand"],
    },
    risk: "safe",
    side: "server",
    async execute({ projectId, subcommand, args }) {
      const graphify = require("../vault-graphify");
      const output = await graphify.queryGraphify(
        String(projectId || ""),
        String(subcommand || ""),
        Array.isArray(args) ? args.map(String) : []
      );
      return { output: truncate(output) };
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
        execFile(
          "/bin/sh",
          ["-c", cmd],
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
    // Compatibility name retained for saved prompts. Execution is now a
    // provider-neutral Codex-owned mission rather than a direct Claude escape.
    name: "claude_agent",
    description:
      "Create a durable Codex-owned Jarvis mission for research or multi-step work. The legacy action name is kept only for saved prompts.",
    params: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "A clear, self-contained mission objective.",
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
          "Mission delegation is off - enable it in Settings → Assistant Access."
        );
      }
      const missions = require("../missions");
      const mission = await missions.createMission({
        prompt: String(task || ""),
        domain: "personal",
        interaction: "durable_mission",
        origin: "api",
      });
      return { id: mission.id, missionId: mission.id, view: `/missions/${mission.id}` };
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
