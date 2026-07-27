/**
 * @file vault-engine.test.js
 * @description Tests for the Phase T entity engine: defensive JSON parsing,
 * promotion-on-second-mention (with retroactive linking of the first
 * mentioning note), immediate attach when a note by that name already exists,
 * alias matching, idempotent links-block rewriting that never touches human
 * prose, codegraph/agent scoping, engine-only write access to people/ and
 * reference/, and un-promotion when a promoted file is deleted. Temp DB +
 * temp vault dir; the brain router is faked per-test (providers disabled).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vault-engine-test-"));
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

const { stmts } = require("../db");
const vault = require("../lib/vault");
const notes = require("../lib/notes");
const engine = require("../lib/vault-engine");

/** Fake brain router: entities per note title (parsed off the prompt). */
function fakeRouter(byTitle) {
  return {
    complete: async ({ prompt }) => {
      const m = String(prompt).match(/^Note title: (.*)$/m);
      const ents = (m && byTitle[m[1]]) || [];
      return { text: JSON.stringify(ents), provider: "fake", taskClass: "standard" };
    },
  };
}

function readNote(id) {
  const row = stmts.getNote.get(id);
  return fs.readFileSync(row.path, "utf8");
}

before(() => {
  vault.init();
});

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("parseEntitiesJson", () => {
  it("salvages arrays from fences and prose, drops malformed entries", () => {
    assert.deepEqual(engine.parseEntitiesJson('```json\n[{"name":"Alex","type":"person"}]\n```'), [
      { name: "Alex", type: "person", aliases: [] },
    ]);
    assert.deepEqual(
      engine.parseEntitiesJson('Sure! Here you go: [{"name":"X","type":"weird"}] Hope it helps.'),
      [{ name: "X", type: "topic", aliases: [] }]
    );
    assert.deepEqual(engine.parseEntitiesJson("no json at all"), []);
    assert.deepEqual(engine.parseEntitiesJson('[{"type":"person"}]'), []);
    assert.deepEqual(engine.parseEntitiesJson(null), []);
  });
});

describe("scoping", () => {
  it("skips agent/ and codegraph/ paths", () => {
    const dir = notes.getNotesDir();
    assert.equal(engine.isSkippedPath(path.join(dir, "agent", "runs", "x.md")), true);
    assert.equal(engine.isSkippedPath(path.join(dir, "projects", "p", "codegraph", "x.md")), true);
    assert.equal(engine.isSkippedPath(path.join(dir, "inbox", "x.md")), false);
    assert.equal(engine.isSkippedPath("/outside/vault.md"), true);
  });
});

describe("engine-only write access", () => {
  it("lets source:engine write people/ and reference/, others still refused", () => {
    const ok = vault.writeVaultFile({
      folder: "people",
      title: "Engine Person",
      body: "stub",
      source: "engine",
    });
    assert.ok(ok.path.includes(`${path.sep}people${path.sep}`));
    assert.throws(
      () => vault.writeVaultFile({ folder: "people", title: "Sneaky", body: "x", source: "agent" }),
      /limited to/
    );
    notes.deleteNote(ok.id);
  });
});

describe("promotion on second mention + retroactive linking", () => {
  let song, second;

  it("first mention records the entity but creates no file", async () => {
    song = notes.createNote({ title: "Song lyrics", body: "a verse about Alex somewhere" });
    const res = await engine.runEngine({
      router: fakeRouter({
        "Song lyrics": [{ name: "Alex", type: "person", aliases: ["Alex Rivera"] }],
      }),
    });
    assert.equal(res.notesScanned >= 1, true);
    assert.equal(res.entitiesCreated, 0);
    const ent = engine.findEntity("Alex");
    assert.ok(ent, "entity not recorded");
    assert.equal(ent.note_id, null);
    assert.equal(readNote(song.id).includes("jarvis:links"), false);
  });

  it("second mention promotes and links BOTH notes (first one retroactively)", async () => {
    second = notes.createNote({ title: "Standup notes", body: "pair with Alex on the API" });
    const res = await engine.runEngine({
      router: fakeRouter({
        "Standup notes": [{ name: "Alex", type: "person", aliases: [] }],
      }),
    });
    assert.equal(res.entitiesCreated, 1);
    const ent = engine.findEntity("Alex");
    assert.ok(ent.note_id, "entity was not promoted");
    const promoted = stmts.getNote.get(ent.note_id);
    assert.ok(promoted.path.includes(`${path.sep}people${path.sep}`));
    // Obsidian alias resolution: promoted file carries the aliases property.
    assert.match(fs.readFileSync(promoted.path, "utf8"), /aliases: \[Alex Rivera\]/);
    for (const id of [song.id, second.id]) {
      const raw = readNote(id);
      assert.match(raw, /<!-- jarvis:links -->\nRelated: \[\[Alex\]\]\n<!-- \/jarvis:links -->/);
    }
    // The wikilinks flowed into the edge graph through the normal pipeline.
    const node = vault.node(ent.note_id);
    const from = node.backlinks.map((b) => b.id).sort();
    assert.deepEqual(from, [song.id, second.id].sort());
  });

  it("a re-run is a no-op (idempotent blocks, cursor advanced)", async () => {
    const before = readNote(song.id);
    const res = await engine.runEngine({ router: fakeRouter({}) });
    assert.equal(res.notesLinked, 0);
    assert.equal(res.entitiesCreated, 0);
    assert.equal(readNote(song.id), before);
  });

  it("matches later mentions through aliases", async () => {
    const third = notes.createNote({ title: "Party plan", body: "invite Alex Rivera" });
    await engine.runEngine({
      router: fakeRouter({
        "Party plan": [{ name: "Alex Rivera", type: "person", aliases: [] }],
      }),
    });
    // No second "Alex Rivera" entity - the alias matched the existing one.
    const all = stmts.listVaultEntities.all().filter((e) => /alex/i.test(e.name));
    assert.equal(all.length, 1);
    assert.match(readNote(third.id), /Related: \[\[Alex\]\]/);
  });
});

describe("immediate attach when the note already exists", () => {
  it("links on FIRST mention if a note answers to the name", async () => {
    const hub = vault.writeVaultFile({
      folder: "people",
      title: "Jordan",
      body: "my manager",
      source: "engine",
    });
    const memo = notes.createNote({ title: "One on one", body: "sync with Jordan tomorrow" });
    await engine.runEngine({
      router: fakeRouter({ "One on one": [{ name: "Jordan", type: "person", aliases: [] }] }),
    });
    assert.match(readNote(memo.id), /Related: \[\[Jordan\]\]/);
    const node = vault.node(hub.id);
    assert.ok(node.backlinks.some((b) => b.id === memo.id));
  });
});

describe("links block never touches human prose", () => {
  it("replaces only the fenced block; everything else stays byte-identical", () => {
    const dir = notes.getNotesDir();
    const file = path.join(dir, "inbox", "handwritten.md");
    const human =
      "---\ntitle: Handwritten\nweird_yaml: {nested: [1, 2]}\n---\n\n# My note\n\ntext body\n";
    fs.writeFileSync(file, human, "utf8");
    assert.equal(engine.upsertLinksBlock(file, ["Alpha"]), true);
    const withBlock = fs.readFileSync(file, "utf8");
    assert.ok(withBlock.startsWith(human.trimEnd()), "human content was altered");
    assert.match(withBlock, /Related: \[\[Alpha\]\]/);
    // Same titles → no write; changed titles → block swapped in place.
    assert.equal(engine.upsertLinksBlock(file, ["Alpha"]), false);
    assert.equal(engine.upsertLinksBlock(file, ["Alpha", "Beta"]), true);
    const swapped = fs.readFileSync(file, "utf8");
    assert.ok(swapped.startsWith(human.trimEnd()));
    assert.match(swapped, /Related: \[\[Alpha\]\], \[\[Beta\]\]/);
    assert.equal(swapped.match(/jarvis:links/g).length, 2); // one open + one close
    // Empty set removes the block entirely.
    assert.equal(engine.upsertLinksBlock(file, []), true);
    assert.equal(fs.readFileSync(file, "utf8").includes("jarvis:links"), false);
  });
});

describe("deletion bookkeeping", () => {
  it("deleting a promoted file un-promotes the entity", async () => {
    const ent = engine.findEntity("Alex");
    assert.ok(ent.note_id);
    notes.deleteNote(ent.note_id);
    const again = stmts.getVaultEntity.get(ent.id);
    assert.equal(again.note_id, null);
  });
});

describe("status", () => {
  it("reports last run and entity counts", () => {
    const s = engine.getStatus();
    assert.equal(s.running, false);
    assert.ok(s.lastRun, "lastRun missing after runs");
    assert.ok(s.totalEntities >= 2);
  });
});
