/**
 * @file vault-graphify.test.js
 * @description Tests for the Phase T3 graphify bridge: opt-in list roundtrip,
 * the full run pipeline against a faked graphify CLI (extract → label →
 * obsidian export → overview note), codegraph containment (exports are never
 * indexed; the overview note is the single dashboard node, stitched to the
 * project hub), wipe safety, human-edit protection on the overview note, and
 * route validation. Temp DB + temp vault dir; no real graphify binary needed.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vault-graphify-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.JARVIS_NOTES_DIR = path.join(TMP, "JarvisNotes");
process.env.PROVIDERS_CONFIG_PATH = path.join(TMP, "providers.json");
fs.writeFileSync(
  process.env.PROVIDERS_CONFIG_PATH,
  JSON.stringify({
    gemini: { enabled: false, apiKey: "" },
    ollama: { enabled: false },
    claude: { enabled: false },
    openai: { enabled: false },
  })
);

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const vault = require("../lib/vault");
const notes = require("../lib/notes");
const graphify = require("../lib/vault-graphify");

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

/** Fake graphify CLI: extract writes graph.json, export writes per-node notes. */
const calls = [];
async function fakeExec(args) {
  calls.push(args);
  if (args[0] === "extract") {
    const out = path.join(REPO, "graphify-out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, "graph.json"),
      JSON.stringify({ nodes: [{ id: "fn a" }, { id: "fn b" }], edges: [{ s: "fn a", t: "fn b" }] })
    );
  } else if (args[0] === "label") {
    throw new Error("claude-cli unavailable in tests"); // must be fail-soft
  } else if (args[0] === "export") {
    const dir = args[args.indexOf("--dir") + 1];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "fn a.md"), "# fn a\n\n[[fn b]]\n");
    fs.writeFileSync(path.join(dir, "fn b.md"), "# fn b\n");
    fs.writeFileSync(path.join(dir, "graph.canvas"), "{}");
  }
  return "";
}

before(async () => {
  vault.init();
  fs.mkdirSync(REPO, { recursive: true });
  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  const proj = await req("POST", "/api/projects", { name: "Graphify Proj" });
  projectId = proj.body.project.id;
  db.prepare("INSERT INTO project_paths (id, project_id, repo_path) VALUES (?, ?, ?)").run(
    "gp-1",
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

describe("opt-in list", () => {
  it("roundtrips through the API", async () => {
    const put = await req("PUT", "/api/vault/graphify-projects", { projectIds: [projectId] });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.projectIds, [projectId]);
    const get = await req("GET", "/api/vault/graphify-projects");
    assert.deepEqual(get.body.projectIds, [projectId]);
  });
});

describe("run pipeline (faked CLI)", () => {
  it("extracts, exports, and writes ONE indexed overview note stitched to the hub", async () => {
    const res = await graphify.runGraphify(projectId, { exec: fakeExec });
    assert.equal(res.nodes, 2);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["extract", "label", "export"] // label failed but the run continued
    );
    assert.ok(calls[0].includes("--code-only"), "extraction must be code-only (no API key)");
    assert.ok(calls[1].includes("--backend=claude-cli"), "labeling must use the claude session");

    const vaultDir = notes.getNotesDir();
    const exportDir = path.join(vaultDir, "projects", "graphify-proj", "codegraph");
    assert.ok(fs.existsSync(path.join(exportDir, "fn a.md")), "export missing");

    // Containment: per-symbol notes are NOT in the index...
    notes.reindexAll();
    const rows = stmts.listNotes.all();
    assert.ok(!rows.some((r) => r.path.includes(`${path.sep}codegraph${path.sep}`)));
    // ...but the overview note IS, and it wikilinks the project hub.
    const overview = rows.find((r) => r.title === "Graphify Proj codegraph");
    assert.ok(overview, "overview note missing from the index");
    const node = vault.node(overview.id);
    assert.ok(
      node.outgoing.some((l) => l.resolved && l.title === "Graphify Proj"),
      "overview is not stitched to the project hub"
    );
  });

  it("regenerates the export wholesale and keeps the overview's note id stable", async () => {
    const stale = path.join(
      notes.getNotesDir(),
      "projects",
      "graphify-proj",
      "codegraph",
      "stale.md"
    );
    fs.writeFileSync(stale, "left over from a previous run\n");
    const before = stmts.listNotes.all().find((r) => r.title === "Graphify Proj codegraph");
    await graphify.runGraphify(projectId, { exec: fakeExec });
    assert.equal(fs.existsSync(stale), false, "previous export was not wiped");
    const after = stmts.listNotes.all().find((r) => r.title === "Graphify Proj codegraph");
    assert.equal(after.id, before.id, "overview note id changed across runs");
  });

  it("refuses to overwrite a human-edited overview note", async () => {
    const file = path.join(notes.getNotesDir(), "projects", "graphify-proj-codegraph.md");
    const human = fs
      .readFileSync(file, "utf8")
      .replace("source: engine", "source: manual")
      .replace(/Code knowledge graph/, "MY OWN NOTES");
    fs.writeFileSync(file, human, "utf8");
    await graphify.runGraphify(projectId, { exec: fakeExec });
    assert.match(fs.readFileSync(file, "utf8"), /MY OWN NOTES/);
  });
});

describe("wipe safety", () => {
  it("only ever deletes a codegraph folder inside the vault", () => {
    assert.throws(() => graphify.wipeCodegraphDir(path.join(TMP, "elsewhere")), /refusing/);
    assert.throws(
      () => graphify.wipeCodegraphDir(path.join(notes.getNotesDir(), "projects")),
      /refusing/
    );
  });
});

describe("route validation", () => {
  it("400s when not opted in, 404s without a repo path, 202s otherwise", async () => {
    const notOpted = await req("POST", "/api/vault/graphify/run", { projectId: "nope" });
    assert.equal(notOpted.status, 400);

    const proj2 = await req("POST", "/api/projects", { name: "No Repo" });
    await req("PUT", "/api/vault/graphify-projects", {
      projectIds: [projectId, proj2.body.project.id],
    });
    const noRepo = await req("POST", "/api/vault/graphify/run", {
      projectId: proj2.body.project.id,
    });
    assert.equal(noRepo.status, 404);

    // Happy path returns 202 immediately; the background run fails fast in
    // tests (no real graphify binary) and must not take the server down.
    const ok = await req("POST", "/api/vault/graphify/run", { projectId });
    assert.equal(ok.status, 202);
    await new Promise((r) => setTimeout(r, 100));
    const status = await req("GET", "/api/vault/graphify/status");
    assert.equal(status.status, 200);
  });
});
