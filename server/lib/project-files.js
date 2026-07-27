/**
 * @file project-files.js
 * @description Read-only filesystem access into a project's repo (Phase T4),
 * for MCP tools that need to look past the vault at the actual source. Reuses
 * `repoPathFor` from vault-graphify.js as the single project-id -> repo-path
 * lookup. Every path is resolved and checked against the repo root before
 * touching disk - the one thing here that must never regress.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { repoPathFor } = require("./vault-graphify");

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LIST_FILES = 5000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache"]);

function notFound(message) {
  const err = new Error(message);
  err.code = "ENOTFOUND";
  return err;
}

/** Resolve `relPath` against the project's repo root; throws EACCES if it
 *  would escape the root (the only thing that must never regress here). */
function resolveInRepo(projectId, relPath) {
  const repo = repoPathFor(projectId);
  if (!repo) throw notFound("project has no repo path on disk");
  const resolved = path.resolve(repo, relPath || ".");
  const rel = path.relative(repo, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const err = new Error("path escapes project repo root");
    err.code = "EACCES";
    throw err;
  }
  return { repo, resolved };
}

function listViaGit(repo) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-files", "-co", "--exclude-standard"],
      { cwd: repo, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.split("\n").filter(Boolean));
      }
    );
  });
}

function listViaWalk(root) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < MAX_LIST_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name));
      } else if (out.length < MAX_LIST_FILES) {
        out.push(path.relative(root, path.join(dir, e.name)));
      }
    }
  }
  return out;
}

/** List files under a project's repo (optionally scoped to a subpath).
 *  Prefers `git ls-files` (respects .gitignore, tracked + untracked); falls
 *  back to a bounded directory walk when the repo isn't git-managed. */
async function listProjectFiles(projectId, subpath = "") {
  const { repo, resolved } = resolveInRepo(projectId, subpath);
  let files;
  try {
    files = await listViaGit(repo);
  } catch {
    files = listViaWalk(repo);
  }
  if (subpath && subpath.trim()) {
    const prefix = path.relative(repo, resolved);
    files = files.filter((f) => f === prefix || f.startsWith(prefix + path.sep));
  }
  return files.slice(0, MAX_LIST_FILES);
}

/** Read one file's contents as utf8, capped at MAX_READ_BYTES. */
function readProjectFile(projectId, relPath) {
  const { resolved } = resolveInRepo(projectId, relPath);
  const stat = fs.statSync(resolved); // throws ENOENT if missing - caller's problem to report
  if (!stat.isFile()) throw notFound("path is not a file");
  if (stat.size > MAX_READ_BYTES) {
    const err = new Error(`file too large (${stat.size} bytes, cap is ${MAX_READ_BYTES})`);
    err.code = "ETOOBIG";
    throw err;
  }
  return fs.readFileSync(resolved, "utf8");
}

module.exports = { listProjectFiles, readProjectFile };
