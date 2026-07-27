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
    assert.deepEqual(
      engine.parseEntitiesJson('```json\n[{"name":"Afroze","type":"person"}]\n```'),
      [{ name: "Afroze", type: "person", aliases: [], facts: [] }]
    );
    assert.deepEqual(
      engine.parseEntitiesJson('Sure! Here you go: [{"name":"X","type":"weird"}] Hope it helps.'),
      [{ name: "X", type: "topic", aliases: [], facts: [] }]
    );
    assert.deepEqual(engine.parseEntitiesJson("no json at all"), []);
    assert.deepEqual(engine.parseEntitiesJson('[{"type":"person"}]'), []);
    assert.deepEqual(engine.parseEntitiesJson(null), []);
    assert.deepEqual(
      engine.parseEntitiesJson(
        '[{"name":"Karan Dhillon","type":"person","facts":["Karan Dhillon was born on 19 May 2005."]}]'
      )[0].facts,
      ["Karan Dhillon was born on 19/05/2005."]
    );
  });
});

describe("Terra-derived knowledge propagation", () => {
  it("materializes target-specific facts for every entity type with source attribution", async () => {
    const ayaan = vault.writeVaultFile({
      folder: "people",
      title: "Derived Ayaan",
      body: "Human profile text.",
      source: "engine",
    });
    const project = vault.writeVaultFile({
      folder: "reference",
      title: "Project Atlas",
      body: "Human project text.",
      source: "engine",
    });
    const source = notes.createNote({
      title: "Semantic source",
      body: "A note containing knowledge that Terra must reason about for [[Project Atlas]].",
    });
    assert.match(engine.relatedContext(stmts.getNote.get(source.id)), /Human project text\./);

    await engine.runEngine({
      rescanIds: [source.id],
      router: fakeRouter({
        "Semantic source": [
          {
            name: "Derived Ayaan",
            type: "person",
            aliases: [],
            facts: ["Derived Ayaan studied medicine in Bulgaria."],
          },
          {
            name: "Project Atlas",
            type: "project",
            aliases: [],
            facts: ["Project Atlas uses a subscription-backed neural engine."],
          },
        ],
      }),
    });

    assert.match(
      readNote(ayaan.id),
      /Derived Ayaan studied medicine in Bulgaria\. — \[\[Semantic source\]\]/
    );
    assert.match(
      readNote(project.id),
      /Project Atlas uses a subscription-backed neural engine\. — \[\[Semantic source\]\]/
    );
    assert.match(readNote(ayaan.id), /Human profile text\./);
    assert.match(readNote(project.id), /Human project text\./);
  });

  it("replaces one source's old conclusions on rescan without touching human prose", async () => {
    const targetId = vault.resolveKey("derived-ayaan");
    const sourceId = vault.resolveKey("semantic-source");
    await engine.runEngine({
      rescanIds: [sourceId],
      router: fakeRouter({
        "Semantic source": [
          {
            name: "Derived Ayaan",
            type: "person",
            aliases: [],
            facts: ["Derived Ayaan now studies biomedical science in London."],
          },
        ],
      }),
    });

    const raw = readNote(targetId);
    assert.doesNotMatch(raw, /studied medicine in Bulgaria/);
    assert.match(raw, /now studies biomedical science in London/);
    assert.match(raw, /Human profile text\./);
    assert.equal((raw.match(/jarvis:derived-facts/g) || []).length, 2);
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
    song = notes.createNote({ title: "Song lyrics", body: "a verse about Afroze somewhere" });
    const res = await engine.runEngine({
      router: fakeRouter({
        "Song lyrics": [{ name: "Afroze", type: "person", aliases: ["Afroze Khan"] }],
      }),
    });
    assert.equal(res.notesScanned >= 1, true);
    assert.equal(res.entitiesCreated, 0);
    const ent = engine.findEntity("Afroze");
    assert.ok(ent, "entity not recorded");
    assert.equal(ent.note_id, null);
    assert.equal(readNote(song.id).includes("jarvis:links"), false);
  });

  it("second mention promotes and links BOTH notes (first one retroactively)", async () => {
    second = notes.createNote({ title: "Standup notes", body: "pair with Afroze on the API" });
    const res = await engine.runEngine({
      router: fakeRouter({
        "Standup notes": [{ name: "Afroze", type: "person", aliases: [] }],
      }),
    });
    assert.equal(res.entitiesCreated, 1);
    const ent = engine.findEntity("Afroze");
    assert.ok(ent.note_id, "entity was not promoted");
    const promoted = stmts.getNote.get(ent.note_id);
    assert.ok(promoted.path.includes(`${path.sep}people${path.sep}`));
    // Obsidian alias resolution: promoted file carries the aliases property.
    assert.match(fs.readFileSync(promoted.path, "utf8"), /aliases: \[Afroze Khan\]/);
    for (const id of [song.id, second.id]) {
      const raw = readNote(id);
      assert.match(raw, /<!-- jarvis:links -->\nRelated: \[\[Afroze\]\]\n<!-- \/jarvis:links -->/);
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
    const third = notes.createNote({ title: "Party plan", body: "invite Afroze Khan" });
    await engine.runEngine({
      router: fakeRouter({
        "Party plan": [{ name: "Afroze Khan", type: "person", aliases: [] }],
      }),
    });
    // No second "Afroze Khan" entity - the alias matched the existing one.
    const all = stmts.listVaultEntities.all().filter((e) => /afroze/i.test(e.name));
    assert.equal(all.length, 1);
    assert.match(readNote(third.id), /Related: \[\[Afroze\]\]/);
  });
});

describe("immediate attach when the note already exists", () => {
  it("links on FIRST mention if a note answers to the name", async () => {
    const hub = vault.writeVaultFile({
      folder: "people",
      title: "Volkan",
      body: "my manager",
      source: "engine",
    });
    const memo = notes.createNote({ title: "One on one", body: "sync with Volkan tomorrow" });
    await engine.runEngine({
      router: fakeRouter({ "One on one": [{ name: "Volkan", type: "person", aliases: [] }] }),
    });
    assert.match(readNote(memo.id), /Related: \[\[Volkan\]\]/);
    const node = vault.node(hub.id);
    assert.ok(node.backlinks.some((b) => b.id === memo.id));
  });

  it("keeps explicit friend links, connects the owner, and uses Terra", async () => {
    const owner = vault.writeVaultFile({
      folder: "people",
      title: "Mushaf Zarrar",
      body: "owner",
      tags: ["identity"],
      source: "engine",
      extraMeta: { aliases: ["Muhammad Mushaf Zarrar"] },
    });
    const ahad = vault.writeVaultFile({
      folder: "people",
      title: "Ahad",
      body: "Friends with [[Ayaan Ali]]",
      source: "engine",
    });
    const friends = notes.createNote({ title: "Friend List", body: "- [[Ayaan Ali]]" });
    let call;
    await engine.runEngine({
      router: {
        complete: async (args) => {
          call = args;
          return { text: "[]" };
        },
      },
    });
    assert.equal(call.providerOptions.codex.model, "gpt-5.6-terra");
    const ayaan = engine.findEntity("Ayaan Ali");
    assert.ok(ayaan.note_id, "two explicit mentions should promote Ayaan");
    assert.match(readNote(ahad.id), /Related: \[\[Ayaan Ali\]\]/);
    assert.match(readNote(friends.id), /\[\[Mushaf Zarrar\]\]/);
    assert.equal(vault.resolveKey("muhammad-mushaf-zarrar"), owner.id);
  });

  it("removes a disposable engine stub when an aliased canonical note exists", async () => {
    const canonical = vault.writeVaultFile({
      folder: "people",
      title: "Canonical Person",
      body: "Real profile",
      source: "engine",
      extraMeta: { aliases: ["Canonical Full Person"] },
    });
    const duplicate = vault.writeVaultFile({
      folder: "people",
      title: "Canonical Full Person",
      body: "*Auto-created by the vault engine - mentioned across your notes. Backlinks show where.*",
      source: "engine",
    });
    assert.equal(vault.resolveKey("canonical-full-person"), canonical.id);
    await engine.runEngine({ router: fakeRouter({}) });
    assert.equal(stmts.getNote.get(duplicate.id), undefined);
    assert.equal(vault.resolveKey("canonical-full-person"), canonical.id);
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
    const ent = engine.findEntity("Afroze");
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
