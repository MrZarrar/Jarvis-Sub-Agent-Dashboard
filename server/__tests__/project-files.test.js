/**
 * @file project-files.test.js
 * @description Tests for the Phase T4 project-file bridge: repo-root path
 * traversal guard (the only thing that must never regress), file listing
 * fallback when a repo isn't git-managed, size cap, and route validation for
 * the graphify query passthrough's subcommand allowlist.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "project-files-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.JARVIS_NOTES_DIR = path.join(TMP, "JarvisNotes");
process.env.PROVIDERS_CONFIG_PATH = path.join(TMP, "providers.json");
fs.writeFileSync(
  process.env.PROVIDERS_CONFIG_PATH,
  JSON.stringify({
    gemini: { enabled: false, apiKey: "" },
    claude: { enabled: false },
    openai: { enabled: false },
  })
);

const { createApp, startServer } = require("../index");
const { db } = require("../db");
const vault = require("../lib/vault");
const projectFiles = require("../lib/project-files");

let server;
let BASE;
let projectId;
const REPO = path.join(TMP, "fake-repo");

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(b || "{}");
          } catch {
            parsed = b;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  vault.init();
  fs.mkdirSync(path.join(REPO, "src"), { recursive: true });
  fs.mkdirSync(path.join(REPO, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(REPO, "src", "a.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(REPO, "node_modules", "dep", "index.js"), "// vendored\n");
  fs.writeFileSync(path.join(REPO, "big.bin"), Buffer.alloc(3 * 1024 * 1024));

  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  const proj = await req("POST", "/api/projects", { name: "File Proj" });
  projectId = proj.body.project.id;
  db.prepare("INSERT INTO project_paths (id, project_id, repo_path) VALUES (?, ?, ?)").run(
    "pf-1",
    projectId,
    REPO
  );
});

after(() => {
  if (server) server.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("listProjectFiles", () => {
  it("walks the repo (not git-managed) and skips node_modules", async () => {
    const files = await projectFiles.listProjectFiles(projectId, "");
    assert.ok(files.includes(path.join("src", "a.js")));
    assert.ok(!files.some((f) => f.includes("node_modules")));
  });
});

describe("readProjectFile", () => {
  it("reads a file inside the repo", () => {
    const content = projectFiles.readProjectFile(projectId, path.join("src", "a.js"));
    assert.match(content, /module\.exports/);
  });

  it("refuses to escape the repo root", () => {
    assert.throws(
      () => projectFiles.readProjectFile(projectId, "../../etc/passwd"),
      /escapes project repo root/
    );
  });

  it("rejects files over the size cap", () => {
    assert.throws(() => projectFiles.readProjectFile(projectId, "big.bin"), /too large/);
  });
});

describe("route validation", () => {
  it("400s without projectId, 403s on traversal, 200s on a real file", async () => {
    const noId = await req("GET", "/api/vault/project-file?path=src/a.js");
    assert.equal(noId.status, 400);

    const escape = await req(
      "GET",
      `/api/vault/project-file?projectId=${projectId}&path=${encodeURIComponent("../../etc/passwd")}`
    );
    assert.equal(escape.status, 403);

    const ok = await req(
      "GET",
      `/api/vault/project-file?projectId=${projectId}&path=${encodeURIComponent("src/a.js")}`
    );
    assert.equal(ok.status, 200);
    assert.match(ok.body.content, /module\.exports/);
  });

  it("graphify/query 400s on an unsupported subcommand", async () => {
    const bad = await req("POST", "/api/vault/graphify/query", {
      projectId,
      subcommand: "rm-rf",
    });
    assert.equal(bad.status, 400);
  });

  it("graphify/query 404s when the project has no repo path", async () => {
    const proj2 = await req("POST", "/api/projects", { name: "No Repo" });
    const res = await req("POST", "/api/vault/graphify/query", {
      projectId: proj2.body.project.id,
      subcommand: "query",
      args: ["foo"],
    });
    assert.equal(res.status, 404);
  });
});
