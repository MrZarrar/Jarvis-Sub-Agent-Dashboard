/**
 * @file store.js
 * @description Skill definitions (Phase H, §H1). Same file-first philosophy as
 * notes (server/lib/notes.js): a skill is a markdown file with YAML frontmatter
 * living in a configurable directory (default `~/JarvisSkills`), so it's
 * editable anywhere, versionable, and agent-readable. Unlike notes there is no
 * SQLite index - the library is small enough (tens, not thousands, of files)
 * that a directory scan on every list/get is simpler and can never drift from
 * disk. Execution HISTORY lives in SQLite (`skill_runs`, see engine.js).
 *
 * Frontmatter shape (parsed by ./yaml.js):
 *   name, icon?, description?, confirm: none|tap|typed, schedule? (5-field cron),
 *   params?: [{ name, type, label?, default?, required? }],
 *   steps: [{ type: shell|agent|brain|notify|phone, ...type-specific fields }]
 *
 * A skill is deliberately a straight pipeline - no nesting, no conditionals
 * (v1, per the plan). Validation here catches the common mistakes (missing
 * name/steps, unknown step type, bad confirm level) so the engine never has to
 * re-check shape mid-run.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { stmts } = require("../../db");
const { parseYaml } = require("./yaml");

const SKILLS_DIR_KEY = "skills_dir";
const STEP_TYPES = new Set(["shell", "agent", "brain", "notify", "phone"]);
const CONFIRM_LEVELS = new Set(["none", "tap", "typed"]);

function defaultSkillsDir() {
  return process.env.JARVIS_SKILLS_DIR || path.join(os.homedir(), "JarvisSkills");
}

function getSkillsDir() {
  try {
    const row = stmts.getSetting.get(SKILLS_DIR_KEY);
    if (row && typeof row.value === "string" && row.value.trim()) return row.value.trim();
  } catch {
    /* fall through to default */
  }
  return defaultSkillsDir();
}

function setSkillsDir(dir) {
  const clean = typeof dir === "string" ? dir.trim() : "";
  if (!clean) throw new Error("skills directory path is required");
  const resolved = path.resolve(untilde(clean));
  fs.mkdirSync(resolved, { recursive: true });
  stmts.setSetting.run(SKILLS_DIR_KEY, resolved);
  return resolved;
}

function untilde(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function ensureSkillsDir() {
  const dir = getSkillsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort - every fs call below is guarded too */
  }
  return dir;
}

// ── Frontmatter (reusing the `---\n...\n---` envelope notes.js uses, but with
// the richer ./yaml.js parser so `params`/`steps` block lists work) ─────────

function splitFrontmatter(raw) {
  const text = String(raw || "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  return { meta: parseYaml(m[1]) || {}, body: m[2] || "" };
}

function slugify(name) {
  const base = String(name || "skill")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "skill";
}

function walkMarkdown(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMarkdown(abs, out, depth + 1);
    else if (ent.isFile() && /\.md$/i.test(ent.name)) out.push(abs);
  }
  return out;
}

/** Validate a parsed frontmatter shape. Returns a list of error strings (empty = valid). */
function validateDefinition(meta) {
  const errors = [];
  if (typeof meta.name !== "string" || !meta.name.trim()) errors.push("name is required");
  if (meta.confirm != null && !CONFIRM_LEVELS.has(meta.confirm)) {
    errors.push(`confirm must be one of: ${[...CONFIRM_LEVELS].join(", ")}`);
  }
  if (!Array.isArray(meta.steps) || meta.steps.length === 0) {
    errors.push("steps must be a non-empty list");
  } else {
    meta.steps.forEach((step, i) => {
      if (!step || typeof step !== "object") {
        errors.push(`step ${i + 1} must be a mapping`);
      } else if (!STEP_TYPES.has(step.type)) {
        errors.push(
          `step ${i + 1} has unknown type "${step.type}" (expected one of ${[...STEP_TYPES].join(", ")})`
        );
      }
    });
  }
  if (meta.params != null && !Array.isArray(meta.params)) {
    errors.push("params must be a list");
  }
  return errors;
}

/** Parse one skill file into an API-shaped definition. Fail-safe: a bad file
 *  yields `{ error }` instead of throwing, so one broken skill never breaks
 *  the whole library listing. */
function parseSkillFile(absPath) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    return null;
  }
  const { meta, body } = splitFrontmatter(raw);
  const errors = validateDefinition(meta);
  const id =
    typeof meta.id === "string" && meta.id.trim()
      ? meta.id.trim()
      : slugify(path.basename(absPath, ".md"));
  return {
    id,
    path: absPath,
    name:
      typeof meta.name === "string" && meta.name.trim()
        ? meta.name.trim()
        : path.basename(absPath, ".md"),
    icon: typeof meta.icon === "string" ? meta.icon : null,
    description:
      typeof meta.description === "string" ? meta.description : (body || "").trim().slice(0, 300),
    confirm: CONFIRM_LEVELS.has(meta.confirm) ? meta.confirm : "tap",
    schedule:
      typeof meta.schedule === "string" && meta.schedule.trim() ? meta.schedule.trim() : null,
    params: Array.isArray(meta.params)
      ? meta.params.filter((p) => p && typeof p === "object" && p.name)
      : [],
    steps: Array.isArray(meta.steps) ? meta.steps : [],
    valid: errors.length === 0,
    errors,
  };
}

/** List every skill in the library (one file scan; cheap at this scale). */
function listSkills() {
  const dir = ensureSkillsDir();
  return walkMarkdown(dir)
    .map(parseSkillFile)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findPathById(id) {
  const dir = ensureSkillsDir();
  for (const abs of walkMarkdown(dir)) {
    const def = parseSkillFile(abs);
    if (def && def.id === id) return abs;
  }
  return null;
}

function getSkill(id) {
  const abs = findPathById(id);
  if (!abs) return null;
  const def = parseSkillFile(abs);
  let raw = "";
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch {
    raw = "";
  }
  return { ...def, raw };
}

/** Skills with a `schedule` cron expression (read by ./cron.js). */
function listScheduledSkills() {
  return listSkills().filter((s) => s.valid && s.schedule);
}

function uniquePath(dir, slug) {
  let candidate = path.join(dir, `${slug}.md`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${slug}-${n}.md`);
    n++;
  }
  return candidate;
}

/** Create a skill from a raw markdown+frontmatter string (the client's editor
 *  is a plain textarea over the whole file, same as Notes). Assigns an `id` in
 *  the frontmatter if the caller didn't supply one. */
function createSkill(raw) {
  const { meta } = splitFrontmatter(raw);
  const errors = validateDefinition(meta);
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { code: "EBADSKILL" });
  const dir = ensureSkillsDir();
  const id = randomUUID();
  const withId = raw.includes("\nid:") || /^---\r?\nid:/.test(raw) ? raw : injectId(raw, id);
  const file = uniquePath(dir, slugify(meta.name));
  fs.writeFileSync(file, withId, "utf8");
  return getSkill(parseSkillFile(file).id);
}

function injectId(raw, id) {
  return raw.replace(/^---\r?\n/, `---\nid: ${id}\n`);
}

/** Overwrite a skill's raw file contents (id/path preserved). */
function updateSkill(id, raw) {
  const abs = findPathById(id);
  if (!abs) return null;
  const { meta } = splitFrontmatter(raw);
  const errors = validateDefinition(meta);
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { code: "EBADSKILL" });
  const withId = raw.includes(`id: ${id}`) ? raw : injectId(raw, id);
  fs.writeFileSync(abs, withId, "utf8");
  return getSkill(id);
}

function deleteSkill(id) {
  const abs = findPathById(id);
  if (!abs) return false;
  try {
    fs.unlinkSync(abs);
  } catch {
    return false;
  }
  return true;
}

// ── Watcher (a skill edited anywhere on disk shows up without a page reload) ─
// No index to rebuild (unlike notes) - just debounce and tell listeners to
// refetch the library.

let watcher = null;
let debounceTimer = null;

function startSkillsWatcher({ broadcast } = {}) {
  const dir = ensureSkillsDir();
  stopSkillsWatcher();
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (filename && !/\.md$/i.test(filename.toString())) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (typeof broadcast === "function") {
          try {
            broadcast("skill_changed", { at: new Date().toISOString() });
          } catch {
            /* best-effort */
          }
        }
      }, 300);
      if (debounceTimer.unref) debounceTimer.unref();
    });
    watcher.on("error", () => {
      /* recursive watch unsupported on some FS - the library still loads on demand */
    });
  } catch {
    // No fs.watch fallback needed here (unlike notes' SQLite index): every
    // list/get call reads straight from disk, so there is nothing to go stale.
  }
}

function stopSkillsWatcher() {
  if (!watcher) return;
  try {
    watcher.close();
  } catch {
    /* ignore */
  }
  watcher = null;
}

module.exports = {
  getSkillsDir,
  setSkillsDir,
  defaultSkillsDir,
  ensureSkillsDir,
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  listScheduledSkills,
  startSkillsWatcher,
  stopSkillsWatcher,
  validateDefinition,
  // exposed for tests
  parseSkillFile,
  splitFrontmatter,
  STEP_TYPES,
  CONFIRM_LEVELS,
};
