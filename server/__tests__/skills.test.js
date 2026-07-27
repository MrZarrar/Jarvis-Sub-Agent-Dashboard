/**
 * @file skills.test.js
 * @description Tests for Skills (Phase H): the YAML-subset parser, the
 * file-first store's CRUD + validation, the execution engine's step handlers
 * (shell/notify/brain) and its confirm-level safety gate, cron matching, and
 * the HTTP surface end to end. Providers are disabled (mirrors notes.test.js)
 * so a `brain` step exercises its honest no-provider-configured failure path
 * rather than making a network/spawn call. `agent` steps are intentionally not
 * exercised here - they spawn a real `claude` process, which is run.test.js's
 * job, not this file's.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.JARVIS_SKILLS_DIR = path.join(TMP, "JarvisSkills");
process.env.PROVIDERS_CONFIG_PATH = path.join(TMP, "providers.json");
fs.writeFileSync(
  process.env.PROVIDERS_CONFIG_PATH,
  JSON.stringify({
    groq: { enabled: false, apiKey: "" },
    gemini: { enabled: false, apiKey: "" },
    ollama: { enabled: false },
    claude: { enabled: false },
    codex: { enabled: false },
    openai: { enabled: false },
  })
);

const { parseYaml } = require("../lib/skills/yaml");
const store = require("../lib/skills/store");
const engine = require("../lib/skills/engine");
const { matchesCron } = require("../lib/skills/cron");
const { createApp, startServer } = require("../index");
const { db } = require("../db");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFinish(runId, tries = 50) {
  for (let i = 0; i < tries; i++) {
    const res = await req("GET", `/api/skills/runs/${runId}`);
    if (res.body.run && res.body.run.status !== "running") return res.body.run;
    await sleep(50);
  }
  throw new Error(`run ${runId} did not finish in time`);
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

describe("skills yaml parser", () => {
  it("parses scalars, block lists of maps, and block scalars", () => {
    const doc = parseYaml(
      [
        "name: Test",
        "confirm: none",
        "params:",
        "  - name: a",
        '    default: "1"',
        "steps:",
        "  - type: shell",
        "    command: echo hi",
        "  - type: brain",
        "    prompt: |",
        "      line one",
        "      line two",
      ].join("\n")
    );
    assert.equal(doc.name, "Test");
    assert.equal(doc.confirm, "none");
    assert.deepEqual(doc.params, [{ name: "a", default: "1" }]);
    assert.equal(doc.steps.length, 2);
    assert.equal(doc.steps[0].type, "shell");
    assert.equal(doc.steps[0].command, "echo hi");
    assert.equal(doc.steps[1].prompt, "line one\nline two");
  });

  it("parses inline arrays and typed scalars", () => {
    const doc = parseYaml(["tags: [a, b, c]", "timeout: 30", "wait: true"].join("\n"));
    assert.deepEqual(doc.tags, ["a", "b", "c"]);
    assert.equal(doc.timeout, 30);
    assert.equal(doc.wait, true);
  });
});

describe("skills store", () => {
  it("reports the configured skills directory", async () => {
    const res = await req("GET", "/api/skills/config");
    assert.equal(res.status, 200);
    assert.equal(res.body.dir, path.join(TMP, "JarvisSkills"));
  });

  it("rejects a skill with no steps", () => {
    assert.throws(() => store.createSkill("---\nname: Bad\n---\n"), /steps/);
  });

  it("creates, lists, updates, and deletes a skill file", async () => {
    const raw = [
      "---",
      "name: Echo Skill",
      "confirm: none",
      "steps:",
      "  - type: shell",
      '    command: "echo hello"',
      "---",
      "",
    ].join("\n");
    const created = await req("POST", "/api/skills", { raw });
    assert.equal(created.status, 201);
    const id = created.body.skill.id;
    assert.equal(created.body.skill.name, "Echo Skill");
    assert.equal(created.body.skill.valid, true);

    const list = await req("GET", "/api/skills");
    assert.ok(list.body.items.some((s) => s.id === id));

    const updated = await req("PUT", `/api/skills/${id}`, {
      raw: raw.replace("Echo Skill", "Echo Skill Renamed"),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.skill.name, "Echo Skill Renamed");

    const removed = await req("DELETE", `/api/skills/${id}`);
    assert.equal(removed.status, 200);
    const after404 = await req("GET", `/api/skills/${id}`);
    assert.equal(after404.status, 404);
  });
});

describe("skills engine", () => {
  it("runs a confirm:none shell skill and records step output", async () => {
    const created = await req("POST", "/api/skills", {
      raw: [
        "---",
        "name: Shell Echo",
        "confirm: none",
        "steps:",
        "  - type: shell",
        '    command: "echo hi-from-shell"',
        "---",
        "",
      ].join("\n"),
    });
    const id = created.body.skill.id;
    const run = await req("POST", `/api/skills/${id}/run`, {});
    assert.equal(run.status, 201);
    const finished = await waitForFinish(run.body.run.id);
    assert.equal(finished.status, "success");
    assert.equal(finished.steps[0].status, "success");
    assert.match(finished.steps[0].output, /hi-from-shell/);
  });

  it("interpolates params into a shell command", async () => {
    const created = await req("POST", "/api/skills", {
      raw: [
        "---",
        "name: Echo Param",
        "confirm: none",
        "steps:",
        "  - type: shell",
        '    command: "echo {word}"',
        "---",
        "",
      ].join("\n"),
    });
    const id = created.body.skill.id;
    const run = await req("POST", `/api/skills/${id}/run`, { params: { word: "xyzzy" } });
    const finished = await waitForFinish(run.body.run.id);
    assert.equal(finished.status, "success");
    assert.match(finished.steps[0].output, /xyzzy/);
  });

  it("fails a run cleanly when a shell step errors, without running later steps", async () => {
    const created = await req("POST", "/api/skills", {
      raw: [
        "---",
        "name: Failing Shell",
        "confirm: none",
        "steps:",
        "  - type: shell",
        '    command: "exit 1"',
        "  - type: shell",
        '    command: "echo should-not-run"',
        "---",
        "",
      ].join("\n"),
    });
    const id = created.body.skill.id;
    const run = await req("POST", `/api/skills/${id}/run`, {});
    const finished = await waitForFinish(run.body.run.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.steps[0].status, "failed");
    assert.equal(finished.steps[1].status, "pending");
  });

  it("gives an honest failure when a brain step has no provider configured", async () => {
    const created = await req("POST", "/api/skills", {
      raw: [
        "---",
        "name: Brain No Provider",
        "confirm: none",
        "steps:",
        "  - type: brain",
        "    prompt: hello",
        "---",
        "",
      ].join("\n"),
    });
    const id = created.body.skill.id;
    const run = await req("POST", `/api/skills/${id}/run`, {});
    const finished = await waitForFinish(run.body.run.id);
    assert.equal(finished.status, "failed");
    assert.match(finished.error, /no brain provider is configured/);
  });

  it("requires typed confirmation to match the skill name", async () => {
    const created = await req("POST", "/api/skills", {
      raw: [
        "---",
        "name: Delete Stuff",
        "confirm: typed",
        "steps:",
        "  - type: shell",
        '    command: "echo would-delete"',
        "---",
        "",
      ].join("\n"),
    });
    const id = created.body.skill.id;

    const noText = await req("POST", `/api/skills/${id}/run`, {});
    assert.equal(noText.status, 409);
    assert.equal(noText.body.error.code, "ECONFIRM");

    const wrongText = await req("POST", `/api/skills/${id}/run`, { confirmText: "nope" });
    assert.equal(wrongText.status, 409);

    const rightText = await req("POST", `/api/skills/${id}/run`, { confirmText: "Delete Stuff" });
    assert.equal(rightText.status, 201);
    const finished = await waitForFinish(rightText.body.run.id);
    assert.equal(finished.status, "success");
  });

  it("refuses a voice/phone/schedule trigger on anything but confirm:none", () => {
    const skill = store.createSkill(
      [
        "---",
        "name: Needs Tap",
        "confirm: tap",
        "steps:",
        "  - type: shell",
        '    command: "echo hi"',
        "---",
        "",
      ].join("\n")
    );
    assert.throws(
      () => engine.runSkill({ skillId: skill.id, trigger: "voice" }),
      (err) => err.code === "ECONFIRM"
    );
    assert.throws(
      () => engine.runSkill({ skillId: skill.id, trigger: "schedule" }),
      (err) => err.code === "ECONFIRM"
    );
  });

  it("cancels a running skill and kills its shell step", async () => {
    const created = await req("POST", "/api/skills", {
      raw: [
        "---",
        "name: Long Running",
        "confirm: none",
        "steps:",
        "  - type: shell",
        '    command: "sleep 5"',
        "---",
        "",
      ].join("\n"),
    });
    const id = created.body.skill.id;
    const run = await req("POST", `/api/skills/${id}/run`, {});
    // Give the shell step a moment to actually start before cancelling.
    await sleep(100);
    const cancel = await req("POST", `/api/skills/runs/${run.body.run.id}/cancel`, {});
    assert.equal(cancel.status, 200);
    const finished = await waitForFinish(run.body.run.id);
    assert.ok(finished.status === "failed" || finished.status === "cancelled");
  });
});

describe("skills cron matcher", () => {
  it("matches a daily 7am expression only at 7:00", () => {
    assert.equal(matchesCron("0 7 * * *", new Date(2026, 0, 1, 7, 0)), true);
    assert.equal(matchesCron("0 7 * * *", new Date(2026, 0, 1, 7, 1)), false);
    assert.equal(matchesCron("0 7 * * *", new Date(2026, 0, 1, 8, 0)), false);
  });

  it("matches step and range fields", () => {
    assert.equal(matchesCron("*/15 * * * *", new Date(2026, 0, 1, 0, 30)), true);
    assert.equal(matchesCron("*/15 * * * *", new Date(2026, 0, 1, 0, 31)), false);
  });

  it("rejects a malformed expression instead of throwing", () => {
    assert.equal(matchesCron("not a cron", new Date()), false);
  });
});

describe("skills voice intent (server/lib/assistant.js)", () => {
  const { handleAsk } = require("../lib/assistant");

  it("runs a confirm:none skill by name via voice", async () => {
    const created = await req("POST", "/api/skills", {
      raw: [
        "---",
        "name: Voice Runnable",
        "confirm: none",
        "steps:",
        "  - type: shell",
        '    command: "echo voice-ran"',
        "---",
        "",
      ].join("\n"),
    });
    const skillId = created.body.skill.id;
    const res = await handleAsk({ text: "run skill Voice Runnable", source: "siri" });
    assert.equal(res.intent, "run_skill");
    assert.match(res.text, /Running/);
    const finished = await waitForFinish(res.data.runId);
    assert.equal(finished.status, "success");
    assert.equal(finished.skill_id, skillId);
  });

  it("refuses to voice-run a skill that needs confirmation", async () => {
    await req("POST", "/api/skills", {
      raw: [
        "---",
        "name: Voice Blocked",
        "confirm: tap",
        "steps:",
        "  - type: shell",
        '    command: "echo should-not-run"',
        "---",
        "",
      ].join("\n"),
    });
    const res = await handleAsk({ text: "run skill Voice Blocked", source: "siri" });
    assert.equal(res.intent, "run_skill");
    assert.match(res.text, /confirmation/);
  });

  it("gives an honest reply for an unknown skill name", async () => {
    const res = await handleAsk({ text: "run skill Totally Not A Real Skill", source: "siri" });
    assert.equal(res.intent, "run_skill");
    assert.match(res.text, /couldn't find/);
  });
});
