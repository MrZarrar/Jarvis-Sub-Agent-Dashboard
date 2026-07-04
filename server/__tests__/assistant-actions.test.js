/**
 * @file assistant-actions.test.js
 * @description Tests for the Phase M1 assistant action layer: the registry →
 * provider-binding generation, the dispatcher's risk-gate matrix (safe/confirm/
 * typed × interactive/non-interactive sources, plus the confirm-token and typed
 * round-trips), the file-access allowlist, a fake-provider function-calling
 * loop, and prelude-through-dispatcher parity + audit logging. Providers are
 * disabled (like skills.test.js) so nothing makes a network/spawn call.
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aa-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
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

const registry = require("../lib/assistant-actions/registry");
const { dispatch } = require("../lib/assistant-actions/dispatcher");
const { runWithTools } = require("../lib/assistant-actions/agent-loop");
const actions = require("../lib/assistant-actions");
const { handleAsk } = require("../lib/assistant");
const { stmts } = require("../db");

function grantRoot(dir) {
  stmts.setSetting.run(registry.ROOTS_KEY, JSON.stringify([dir]));
}
function clearRoots() {
  stmts.setSetting.run(registry.ROOTS_KEY, JSON.stringify([]));
}

describe("registry → binding generation", () => {
  it("generates one tool spec per registered action, JSON-schema shaped", () => {
    const names = registry.list().map((a) => a.name);
    const specs = registry.geminiToolSpecs();
    assert.equal(specs.length, names.length);
    for (const s of specs) {
      assert.ok(typeof s.name === "string" && s.name);
      assert.ok(typeof s.description === "string" && s.description);
      assert.equal(s.parameters.type, "object");
    }
    // A required param is carried through to the binding.
    const steer = specs.find((s) => s.name === "steer_run");
    assert.deepEqual(steer.parameters.required, ["message"]);
  });

  it("every action declares a risk and a side", () => {
    for (const a of registry.list()) {
      assert.ok(["safe", "confirm", "typed"].includes(a.risk), `${a.name} risk`);
      assert.ok(["server", "client"].includes(a.side), `${a.name} side`);
      if (a.side === "server") assert.equal(typeof a.execute, "function", `${a.name} execute`);
    }
  });
});

describe("dispatcher risk gate", () => {
  it("runs a safe action from a non-interactive source (siri)", async () => {
    const out = await dispatch({ name: "get_status", params: {}, source: "siri" });
    assert.equal(out.status, "done");
    assert.equal(typeof out.result.liveRuns, "number");
  });

  it("DENIES a confirm action from siri (voice can never fire confirm+)", async () => {
    const out = await dispatch({ name: "spawn_run", params: { prompt: "x" }, source: "siri" });
    assert.equal(out.status, "denied");
  });

  it("DENIES a typed action from a scheduled source", async () => {
    const out = await dispatch({
      name: "shell",
      params: { command: "echo x" },
      source: "schedule",
    });
    assert.equal(out.status, "denied");
  });

  it("confirm action from chat needs a token round-trip bound to the params", async () => {
    grantRoot(TMP);
    const target = path.join(TMP, "confirmed.txt");
    const params = { path: target, content: "hello" };

    // First call: no execution, a token comes back.
    const first = await dispatch({ name: "write_file", params, source: "chat" });
    assert.equal(first.status, "needs_confirm");
    assert.ok(first.confirmToken);
    assert.ok(!fs.existsSync(target), "must not write before confirmation");

    // A token bound to different params must NOT unlock this write.
    const wrong = await dispatch({
      name: "write_file",
      params: { path: target, content: "TAMPERED" },
      source: "chat",
      confirmToken: first.confirmToken,
    });
    assert.equal(wrong.status, "needs_confirm");

    // Correct token + same params: executes exactly once.
    const done = await dispatch({
      name: "write_file",
      params,
      source: "chat",
      confirmToken: first.confirmToken,
    });
    assert.equal(done.status, "done");
    assert.equal(fs.readFileSync(target, "utf8"), "hello");

    // The token is single-use.
    const replay = await dispatch({
      name: "write_file",
      params,
      source: "chat",
      confirmToken: first.confirmToken,
    });
    assert.equal(replay.status, "needs_confirm");
  });

  it("typed action from chat requires the action name retyped", async () => {
    const noType = await dispatch({
      name: "shell",
      params: { command: "echo hi" },
      source: "chat",
    });
    assert.equal(noType.status, "needs_confirm");
    assert.equal(noType.requiresTyped, true);

    const wrong = await dispatch({
      name: "shell",
      params: { command: "echo hi" },
      source: "chat",
      typedConfirm: "sh",
    });
    assert.equal(wrong.status, "needs_confirm");

    const ok = await dispatch({
      name: "shell",
      params: { command: "echo hi" },
      source: "chat",
      typedConfirm: "shell",
    });
    assert.equal(ok.status, "done");
    assert.match(ok.result.output, /hi/);
  });

  it("validates required params before running", async () => {
    const out = await dispatch({ name: "steer_run", params: {}, source: "chat" });
    assert.equal(out.status, "error");
    assert.match(out.error, /message/);
  });

  it("client-side actions are gated+logged but returned, not executed", async () => {
    const out = await dispatch({
      name: "set_hud_mode",
      params: { mode: "ultron" },
      source: "chat",
    });
    assert.equal(out.status, "done");
    assert.equal(out.side, "client");
    assert.deepEqual(out.params, { mode: "ultron" });
  });
});

describe("file-access allowlist", () => {
  it("denies file access with no roots granted", async () => {
    clearRoots();
    const out = await dispatch({
      name: "read_file",
      params: { path: path.join(TMP, "x") },
      source: "chat",
    });
    assert.equal(out.status, "error");
    assert.match(out.error, /root/i);
  });

  it("denies a path outside the granted roots", async () => {
    grantRoot(TMP);
    const out = await dispatch({
      name: "read_file",
      params: { path: "/etc/hosts" },
      source: "chat",
    });
    assert.equal(out.status, "error");
    assert.match(out.error, /outside/i);
  });
});

describe("fake-provider function-calling loop", () => {
  it("dispatches a safe tool call and feeds the result back, then answers", async () => {
    let round = 0;
    const fake = {
      capabilities: { tools: true },
      isConfigured: () => true,
      async callWithTools(messages) {
        round++;
        if (round === 1) return { text: "", toolCalls: [{ name: "get_status", args: {} }] };
        // second round sees the tool result in the convo
        const toolTurn = messages.find((m) => m.role === "tool");
        assert.ok(toolTurn, "the loop must feed a tool result back");
        return { text: "All quiet.", toolCalls: [] };
      },
    };
    const out = await runWithTools({
      providerMod: fake,
      messages: [{ role: "user", content: "status?" }],
      source: "chat",
    });
    assert.equal(out.text, "All quiet.");
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].name, "get_status");
    assert.equal(out.actions[0].status, "done");
  });

  it("a confirm action called by the model is surfaced, never self-executed", async () => {
    const fake = {
      capabilities: { tools: true },
      isConfigured: () => true,
      async callWithTools() {
        return { text: "queued", toolCalls: [{ name: "spawn_run", args: { prompt: "do it" } }] };
      },
    };
    const out = await runWithTools({
      providerMod: fake,
      messages: [{ role: "user", content: "spawn a run" }],
      source: "chat",
      maxIters: 1,
    });
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].name, "spawn_run");
    assert.equal(out.actions[0].status, "needs_confirm");
    assert.ok(out.actions[0].confirmToken);
  });
});

describe("spoken provider directive", () => {
  it("parses a bare directive and strips it", () => {
    assert.deepEqual(actions.parseProviderDirective("use claude"), {
      provider: "claude",
      remainder: "",
    });
    const d = actions.parseProviderDirective("switch to gemini and what's running");
    assert.equal(d.provider, "gemini");
    assert.match(d.remainder, /what's running/);
    assert.equal(actions.parseProviderDirective("hello there"), null);
  });
});

describe("provider-failure honesty (bugfix: no silent relabelling)", () => {
  it("surfaces requestedProvider + providerError when the requested provider is unavailable", async () => {
    // Every provider is disabled in this suite's config, so requesting "gemini"
    // explicitly must fail over to the tiered router - but honestly, not by
    // quietly pretending the answer always came from whichever provider replied.
    const res = await actions.respond({
      text: "what's running",
      source: "chat",
      provider: "gemini",
    });
    assert.equal(res.requestedProvider, "gemini");
    assert.ok(res.providerError && res.providerError.length > 0, "carries the real failure reason");
    assert.ok(res.text && res.text.length > 0, "still answers via the fallback chain");
  });

  it("handleAsk/ask route forwards requestedProvider + providerError additively", async () => {
    const res = await handleAsk({ text: "tell me something", source: "chat", provider: "gemini" });
    assert.equal(res.requestedProvider, "gemini");
    assert.ok(res.providerError);
  });

  it("omits requestedProvider/providerError entirely on a normal success path", async () => {
    // No explicit provider request + a prelude-matched intent never touches
    // respond() at all, so the fields must be absent (additive, not always-on).
    const res = await handleAsk({ text: "note: nothing failed here", source: "chat" });
    assert.equal(res.requestedProvider, undefined);
    assert.equal(res.providerError, undefined);
  });
});

describe("prelude routes through the dispatcher (parity + audit log)", () => {
  it("note: capture goes through write_note and is logged", async () => {
    const before = stmts.listAssistantActions
      .all(50, 0)
      .filter((r) => r.action === "write_note").length;
    const res = await handleAsk({ text: "note: buy milk", source: "siri" });
    assert.equal(res.intent, "note");
    assert.match(res.text, /Noted/);
    // The capture landed.
    const cap = require("../db")
      .db.prepare("SELECT * FROM assistant_captures WHERE id = ?")
      .get(res.data.id);
    assert.equal(cap.text, "buy milk");
    // And an audit row was written.
    const after = stmts.listAssistantActions.all(50, 0).filter((r) => r.action === "write_note");
    assert.ok(after.length > before);
    assert.equal(after[0].outcome, "done");
    assert.ok(after[0].params_hash, "params are hashed, never stored raw");
  });

  it("kill with no live runs replies honestly", async () => {
    const res = await handleAsk({ text: "kill all", source: "siri" });
    assert.equal(res.intent, "kill");
    assert.match(res.text, /no live dashboard runs/);
  });
});

describe("HUD-mode prelude (M2 acceptance path)", () => {
  const { matchHudMode } = require("../lib/assistant");

  it("matches explicit mode commands, ignores bare name greetings", () => {
    assert.equal(matchHudMode("enable ultron"), "ultron");
    assert.equal(matchHudMode("switch to jarvis"), "jarvis");
    assert.equal(matchHudMode("ultron mode"), "ultron");
    assert.equal(matchHudMode("hud auto"), "auto");
    // Not a mode switch - a greeting must fall through to the brain.
    assert.equal(matchHudMode("hey jarvis how are you"), null);
    assert.equal(matchHudMode("what's running"), null);
  });

  it("'enable ultron' returns a done set_hud_mode client action + one-liner", async () => {
    const res = await handleAsk({ text: "enable ultron", source: "chat" });
    assert.ok(Array.isArray(res.actions) && res.actions.length === 1);
    const a = res.actions[0];
    assert.equal(a.name, "set_hud_mode");
    assert.equal(a.params.mode, "ultron");
    assert.equal(a.status, "done");
    assert.equal(a.side, "client");
    assert.match(res.text, /ultron/i);
  });
});
