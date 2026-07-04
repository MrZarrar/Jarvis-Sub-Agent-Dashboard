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

// ── Autonomy (the `claude_agent` delegate; Settings-managed, off by default) ──
// "off"  → the agent tool refuses (mini-Jarvis stays text-only).
// "ask"  → risk "confirm": Gemini proposes it, the human taps once in the popup.
// "auto" → risk "safe": Gemini (and even Siri/scheduled) fire it inline, no tap.
// The user opts into the level in Settings; nothing here is silently weakened.
const AUTONOMY_KEY = "assistant_autonomy";

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
    execute({ q }) {
      const notes = require("../notes");
      const rows = notes.listNotes({ q: String(q || "").trim() || null, limit: 20 });
      return { results: rows.map((n) => ({ id: n.id, title: n.title })) };
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
};
