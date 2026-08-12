/**
 * @file notes.test.js
 * @description Tests for Notes + mini-Jarvis brain (Phase G): notes CRUD over the
 * file+index store, FTS search, tag listing, notes-dir config, the brain-dump
 * reformatting flow (deterministic fallback - providers are disabled so no model
 * call happens), capture-inbox draining, and the project-pulse tracker. Uses
 * Node's built-in test runner with a temp DB + temp notes dir, mirroring
 * projects.test.js.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notes-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.JARVIS_NOTES_DIR = path.join(TMP, "JarvisNotes");
// Disable every provider so the brain-dump flow exercises its deterministic
// (no-model) fallback path - tests never make a network/spawn call.
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
const { db } = require("../db");
const notes = require("../lib/notes");

let server;
let BASE;

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
  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("notes config", () => {
  it("reports the configured notes directory", async () => {
    const res = await req("GET", "/api/notes/config");
    assert.equal(res.status, 200);
    assert.equal(res.body.dir, path.join(TMP, "JarvisNotes"));
  });
});

describe("sensitive note markers", () => {
  it("persists a sensitive marker through creation and an omitted update", () => {
    let created;
    let ordinary;
    try {
      created = notes.createNote({ title: "Private note", body: "Locked", sensitive: true });
      assert.equal(created.sensitive, true);
      assert.match(fs.readFileSync(created.path, "utf8"), /^sensitive: true$/m);

      assert.equal(notes.getNote(created.id), null);
      assert.equal(
        notes.listNotes().some((note) => note.id === created.id),
        false
      );
      assert.equal(
        notes.listTags().some((tag) => tag.tag === "private-tag"),
        false
      );
      assert.equal(notes.updateNote(created.id, { title: "Leaked rename" }), null);
      assert.equal(notes.deleteNote(created.id), false);

      const edited = notes.updateNote(
        created.id,
        { title: "Renamed", tags: ["private-tag"] },
        { includeSensitive: true }
      );
      assert.equal(edited.sensitive, true);
      assert.equal(notes.getNote(created.id, { includeSensitive: true }).title, "Renamed");
      assert.ok(notes.listNotes({ includeSensitive: true }).some((note) => note.id === created.id));
      assert.deepEqual(notes.listTags({ includeSensitive: true }), [
        { tag: "private-tag", count: 1 },
      ]);

      ordinary = notes.createNote({ title: "Ordinary", body: "Public" });
      assert.equal(ordinary.sensitive, false);
    } finally {
      if (created) notes.deleteNote(created.id, { includeSensitive: true });
      if (ordinary) notes.deleteNote(ordinary.id);
    }
  });

  it("indexes only true frontmatter values as sensitive", () => {
    const cases = [
      { name: "true", frontmatter: "sensitive: true", expected: 1 },
      { name: "false", frontmatter: "sensitive: false", expected: 0 },
      { name: "missing", frontmatter: "", expected: 0 },
      { name: "unrecognised", frontmatter: "sensitive: yes", expected: 0 },
    ];

    for (const { name, frontmatter, expected } of cases) {
      const id = `sensitive-${name}`;
      const file = path.join(process.env.JARVIS_NOTES_DIR, `${id}.md`);
      const marker = frontmatter ? `\n${frontmatter}` : "";
      fs.writeFileSync(file, `---\nid: ${id}\ntitle: ${name}${marker}\n---\nbody\n`, "utf8");

      try {
        notes.indexFile(file);
        assert.equal(
          db.prepare("SELECT sensitive FROM notes WHERE id = ?").get(id).sensitive,
          expected
        );
      } finally {
        notes.deleteNote(id);
      }
    }
  });
});

describe("notes CRUD", () => {
  let id;
  let notePath;

  it("creates a note and writes a markdown file with frontmatter", async () => {
    const res = await req("POST", "/api/notes", {
      title: "First note",
      body: "Hello **world**.\n\n- [ ] a todo",
      tags: ["alpha", "beta"],
    });
    assert.equal(res.status, 201);
    id = res.body.note.id;
    notePath = res.body.note.path;
    assert.ok(id);
    assert.deepEqual(res.body.note.tags, ["alpha", "beta"]);
    const raw = fs.readFileSync(notePath, "utf8");
    assert.match(raw, /^---/);
    assert.match(raw, new RegExp(`id: ${id}`));
    assert.match(raw, /Hello \*\*world\*\*/);
  });

  it("lists the note", async () => {
    const res = await req("GET", "/api/notes");
    assert.equal(res.status, 200);
    assert.ok(res.body.items.some((n) => n.id === id));
  });

  it("gets the note with its body", async () => {
    const res = await req("GET", `/api/notes/${id}`);
    assert.equal(res.status, 200);
    assert.match(res.body.note.body, /Hello \*\*world\*\*/);
  });

  it("finds the note via FTS search", async () => {
    const res = await req("GET", "/api/notes?q=world");
    assert.equal(res.status, 200);
    assert.ok(res.body.items.some((n) => n.id === id));
  });

  it("searches note bodies and matches simple plural variants", async () => {
    const friend = await req("POST", "/api/notes", {
      title: "Contact List",
      body: "Casey Morgan appears inside this node.",
    });
    const plural = await req("GET", "/api/notes?q=contacts");
    assert.ok(plural.body.items.some((n) => n.id === friend.body.note.id));
    const body = await req("GET", "/api/notes?q=Casey");
    assert.ok(body.body.items.some((n) => n.id === friend.body.note.id));
    const compound = await req("GET", "/api/notes?q=Contact%20Casey");
    assert.ok(compound.body.items.some((n) => n.id === friend.body.note.id));
    await req("DELETE", `/api/notes/${friend.body.note.id}`);
  });

  it("lists tags with counts", async () => {
    const res = await req("GET", "/api/notes/tags");
    assert.equal(res.status, 200);
    const tags = Object.fromEntries(res.body.items.map((t) => [t.tag, t.count]));
    assert.equal(tags.alpha, 1);
    assert.equal(tags.beta, 1);
  });

  it("updates the note title and body", async () => {
    const res = await req("PUT", `/api/notes/${id}`, {
      title: "Renamed note",
      body: "New body",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.note.title, "Renamed note");
    const raw = fs.readFileSync(notePath, "utf8");
    assert.match(raw, /New body/);
  });

  it("deletes the note and removes the file", async () => {
    const res = await req("DELETE", `/api/notes/${id}`);
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(notePath), false);
    const get = await req("GET", `/api/notes/${id}`);
    assert.equal(get.status, 404);
  });
});

describe("brain-dump (deterministic fallback - no provider)", () => {
  it("previews a dump without saving, extracting heuristic todos", async () => {
    const res = await req("POST", "/api/notes/dump", {
      text: "some thoughts\nTODO: buy milk\nTODO: call bob",
      save: false,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.formatted, false); // no provider configured
    assert.equal(res.body.provider, null);
    assert.deepEqual(res.body.todos, ["buy milk", "call bob"]);
    // Nothing should have been written for a preview.
    const list = await req("GET", "/api/notes");
    assert.equal(list.body.items.length, 0);
  });

  it("saves a dump as a note with source=dump and preserves the original", async () => {
    const res = await req("POST", "/api/notes/dump", {
      text: "raw dump text\nTODO: file this",
      save: true,
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.note);
    assert.equal(res.body.note.source, "dump");
    const raw = fs.readFileSync(res.body.note.path, "utf8");
    assert.match(raw, /original:/);
    assert.match(raw, /raw dump text/);
  });
});

describe("project pulse (Phase G2)", () => {
  it("computes a pulse for a project including open note todos", async () => {
    const projectRes = await req("POST", "/api/projects", { name: "Pulse Project" });
    const projectId = projectRes.body.project.id;

    // A note tagged to the project with two open todos.
    await req("POST", "/api/notes", {
      title: "Project note",
      body: "- [ ] first\n- [ ] second\n- [x] done",
      projectId,
    });

    const res = await req("POST", "/api/projects/pulse/recompute");
    assert.equal(res.status, 200);
    const p = res.body.items.find((x) => x.projectId === projectId);
    assert.ok(p, "pulse row for the project exists");
    assert.equal(p.openTodos, 2);
    // Brand-new project with activity today → active (not neglected).
    assert.equal(p.state, "active");
  });
});
