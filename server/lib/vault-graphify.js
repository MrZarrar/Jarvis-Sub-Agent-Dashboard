/**
 * @file vault-graphify.js
 * @description Graphify bridge (Phase T3). Per-project opt-in: run the local
 * `graphify` CLI over a project's repo and export its knowledge graph into the
 * vault as an Obsidian sub-vault at `projects/<slug>/codegraph/`.
 *
 * Cost posture (locked with the user): extraction is `--code-only` (pure AST,
 * no LLM, no API key) and community labeling uses `--backend claude-cli`
 * (shells out to the user's Claude Code OAuth session - plan usage, no API
 * billing). Labeling is fail-soft: placeholders are fine.
 *
 * Containment (locked): the codegraph folder is Obsidian-only - the notes
 * watcher skips it (notes.js), the entity engine skips it (vault-engine.js).
 * The dashboard graph gets ONE node per codegraph: an engine-owned overview
 * note at `projects/<slug>-codegraph.md` whose `[[Project]]` wikilink stitches
 * it to the project hub. The overview is regenerated each run; it is only ever
 * overwritten when its frontmatter says `source: engine` - a human edit turns
 * it into a human note the engine refuses to touch.
 *
 * Full per-symbol detail stays in `<repo>/graphify-out/graph.json`, queryable
 * in-repo by graphify's own CLI/skill (`query`, `explain`, `path`, `affected`).
 *
 * @author Jarvis (Phase T)
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { stmts } = require("../db");
const notes = require("./notes");
const vault = require("./vault");
const { broadcast } = require("../websocket");

const PROJECTS_KEY = "vault_graphify_projects";
const STATUS_KEY = "vault_graphify_status";
const GRAPHIFY_BIN = process.env.GRAPHIFY_BIN || "graphify";
const EXTRACT_TIMEOUT_MS = 15 * 60_000;
const LABEL_TIMEOUT_MS = 10 * 60_000;
const EXPORT_TIMEOUT_MS = 5 * 60_000;

const running = new Set(); // projectIds with a run in flight

function emit(data) {
  try {
    broadcast("vault_graphify", data);
  } catch {
    /* cosmetic */
  }
}

// ── Opt-in list (mirrors vault_summary_projects) ─────────────────────────────

function getGraphifyProjects() {
  try {
    const row = stmts.getSetting.get(PROJECTS_KEY);
    const arr = row ? JSON.parse(row.value) : [];
    return Array.isArray(arr) ? arr.filter((v) => typeof v === "string" && v) : [];
  } catch {
    return [];
  }
}

function setGraphifyProjects(ids) {
  const clean = Array.isArray(ids)
    ? [...new Set(ids.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()))]
    : [];
  stmts.setSetting.run(PROJECTS_KEY, JSON.stringify(clean));
  return clean;
}

// ── Per-project status (settings JSON map; cheap, no new table) ─────────────

function getStatusMap() {
  try {
    const row = stmts.getSetting.get(STATUS_KEY);
    const map = row ? JSON.parse(row.value) : {};
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

function setStatus(projectId, patch) {
  try {
    const map = getStatusMap();
    map[projectId] = { ...map[projectId], ...patch };
    stmts.setSetting.run(STATUS_KEY, JSON.stringify(map));
  } catch {
    /* fail-safe */
  }
}

function getStatus() {
  return { running: [...running], projects: getStatusMap() };
}

// ── Repo + vault paths ───────────────────────────────────────────────────────

function repoPathFor(projectId) {
  try {
    for (const p of stmts.listAllProjectPaths.all()) {
      if (p.project_id === projectId && p.repo_path && fs.existsSync(p.repo_path)) {
        return p.repo_path;
      }
    }
  } catch {
    /* none */
  }
  return null;
}

function projectName(projectId) {
  try {
    const proj = stmts.getProject.get(projectId);
    return (proj && proj.name) || projectId;
  } catch {
    return projectId;
  }
}

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "project"
  );
}

// ── The run ──────────────────────────────────────────────────────────────────

/** Kick off a graphify run for one project. Long-running (minutes): the route
 *  fires this and returns 202; progress streams as `vault_graphify` WS events.
 *  `exec` is an injectable seam for tests (default: real CLI). */
async function runGraphify(projectId, { exec = execCli } = {}) {
  if (running.has(projectId)) {
    const err = new Error("graphify already running for this project");
    err.code = "EBUSY";
    throw err;
  }
  const repo = repoPathFor(projectId);
  if (!repo) {
    const err = new Error("project has no repo path on disk");
    err.code = "ENOTFOUND";
    throw err;
  }
  running.add(projectId);
  const name = projectName(projectId);
  const slug = slugify(name);
  try {
    emit({ phase: "start", projectId, name });

    // 1) AST extraction - local, no LLM, no key. Writes <repo>/graphify-out/.
    emit({ phase: "extract", projectId });
    await exec([`extract`, repo, `--code-only`], { timeout: EXTRACT_TIMEOUT_MS });

    const graphPath = path.join(repo, "graphify-out", "graph.json");
    const labelsPath = path.join(repo, "graphify-out", ".graphify_labels.json");
    if (!fs.existsSync(graphPath)) throw new Error("graphify produced no graph.json");

    // 2) Community naming via the Claude Code session (plan usage, no API
    //    billing). Fail-soft: unlabeled communities keep placeholders.
    emit({ phase: "label", projectId });
    try {
      await exec([`label`, repo, `--backend=claude-cli`, `--missing-only`], {
        timeout: LABEL_TIMEOUT_MS,
      });
    } catch (err) {
      console.warn("[vault-graphify] labeling skipped:", err?.message || err);
    }

    // 3) Obsidian export into the vault - full per-node import (user's call);
    //    the folder is engine-owned and regenerated wholesale each run.
    emit({ phase: "export", projectId });
    const exportDir = path.join(notes.getNotesDir(), "projects", slug, "codegraph");
    wipeCodegraphDir(exportDir);
    const args = ["export", "obsidian", "--graph", graphPath, "--dir", exportDir];
    if (fs.existsSync(labelsPath)) args.push("--labels", labelsPath);
    await exec(args, { timeout: EXPORT_TIMEOUT_MS });

    // 4) One indexed overview note = the codegraph's single dashboard node,
    //    wikilinked to the project hub.
    const stats = graphStats(graphPath);
    writeOverviewNote({ projectId, name, slug, stats });

    setStatus(projectId, {
      lastRun: new Date().toISOString(),
      ok: true,
      error: null,
      ...stats,
    });
    emit({ phase: "done", projectId, ...stats });
    return { projectId, ...stats };
  } catch (err) {
    setStatus(projectId, { lastRun: new Date().toISOString(), ok: false, error: err.message });
    emit({ phase: "error", projectId, message: err.message });
    throw err;
  } finally {
    running.delete(projectId);
  }
}

function execCli(args, { timeout } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      GRAPHIFY_BIN,
      args,
      { timeout: timeout || EXTRACT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(`graphify ${args[0]} failed: ${String(stderr || err.message).slice(0, 500)}`)
          );
        } else {
          resolve(String(stdout || ""));
        }
      }
    );
  });
}

/** Delete a previous export. Refuses anything that is not a `codegraph`
 *  folder inside the vault - the one rm in this file stays un-footgunable. */
function wipeCodegraphDir(dir) {
  const vaultDir = notes.getNotesDir();
  const rel = path.relative(vaultDir, dir);
  if (rel.startsWith("..") || path.basename(dir) !== "codegraph") {
    throw new Error(`refusing to wipe non-codegraph path: ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function graphStats(graphPath) {
  try {
    const g = JSON.parse(fs.readFileSync(graphPath, "utf8"));
    return {
      nodes: Array.isArray(g.nodes) ? g.nodes.length : 0,
      edges: Array.isArray(g.edges) ? g.edges.length : Array.isArray(g.links) ? g.links.length : 0,
    };
  } catch {
    return { nodes: 0, edges: 0 };
  }
}

/** The single indexed note representing a codegraph in the dashboard graph.
 *  Deterministic path, regenerated per run; overwritten ONLY while its
 *  frontmatter still says `source: engine`. */
function writeOverviewNote({ projectId, name, slug, stats }) {
  const dir = path.join(notes.getNotesDir(), "projects");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}-codegraph.md`);
  if (fs.existsSync(file)) {
    try {
      const meta = notes.parseFrontmatter(fs.readFileSync(file, "utf8")).meta;
      if (meta.source !== "engine") {
        console.warn(`[vault-graphify] ${file} was human-edited; leaving it alone`);
        return null;
      }
    } catch {
      return null;
    }
  }
  const stubId = vault.ensureProjectStub(projectId);
  const stub = stubId ? stmts.getNote.get(stubId) : null;
  const now = new Date().toISOString();
  const { randomUUID } = require("node:crypto");
  const existingId = fs.existsSync(file)
    ? notes.parseFrontmatter(fs.readFileSync(file, "utf8")).meta.id
    : null;
  const meta = {
    id: existingId || randomUUID(),
    title: `${name} codegraph`,
    tags: ["codegraph"],
    project: projectId,
    created: now,
    updated: now,
    source: "engine",
  };
  const body =
    `Code knowledge graph for [[${stub ? stub.title : name}]] - ` +
    `${stats.nodes} symbols, ${stats.edges} relations.\n\n` +
    `Browse the full graph in Obsidian under \`projects/${slug}/codegraph/\` ` +
    `(open \`graph.canvas\` for the community layout). For deep queries, run ` +
    `\`graphify query\`/\`explain\`/\`path\` inside the repo - the per-symbol ` +
    `graph lives in its \`graphify-out/graph.json\`.\n`;
  fs.writeFileSync(file, `${notes.serializeFrontmatter(meta)}\n\n${body}`, "utf8");
  const row = notes.indexFile(file);
  return row ? row.id : null;
}

module.exports = {
  getGraphifyProjects,
  setGraphifyProjects,
  runGraphify,
  getStatus,
  // test seams
  repoPathFor,
  wipeCodegraphDir,
  writeOverviewNote,
  graphStats,
  slugify,
};
