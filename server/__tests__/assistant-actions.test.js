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
process.env.JARVIS_NOTES_DIR = path.join(TMP, "JarvisNotes");
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
    // claude_agent is only offered to the model when autonomy is enabled.
    const listed = registry
      .list()
      .filter((a) => a.name !== "claude_agent" || registry.autonomyMode() !== "off");
    const specs = registry.geminiToolSpecs();
    assert.equal(specs.length, listed.length);
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

describe("vault capture ambiguity", () => {
  it("refuses a partial person name instead of creating a duplicate", () => {
    const vault = require("../lib/vault");
    vault.writeVaultFile({
      folder: "people",
      title: "Ahad Alkozai",
      body: "Known since high school.",
      source: "engine",
    });
    assert.throws(
      () =>
        registry.get("vault_append_fact").execute({ name: "Ahad", fact: "Likes Rocket League" }),
      (err) => err.code === "EAMBIGUOUS" && /Ahad Alkozai/.test(err.message)
    );
  });
});

describe("vault-grounded recall", () => {
  it("routes a unique matching node to Luna without asking for confirmation", async () => {
    const vault = require("../lib/vault");
    vault.writeVaultFile({
      folder: "people",
      title: "Karan Dhillon",
      body: "Date of birth: 19/05/2005.",
      source: "engine",
    });
    const providers = require("../lib/providers");
    const realGet = providers.getChatProvider;
    let messages;
    let selected;
    let options;
    providers.getChatProvider = (name) => {
      selected = name;
      return {
        capabilities: { tools: true },
        isConfigured: () => true,
        async callWithTools(input, _tools, opts) {
          messages = input;
          options = opts;
          return { text: "19/05/2005", toolCalls: [] };
        },
      };
    };
    try {
      const out = await actions.respond({
        text: "what is Karans DOB?",
      });
      assert.equal(out.text, "19/05/2005");
      assert.equal(out.provider, "codex");
      assert.equal(selected, "codex");
      assert.equal(options.model, "gpt-5.6-luna");
      assert.match(messages[0].content, /Karan Dhillon[\s\S]*19\/05\/2005/);
      assert.match(messages[0].content, /one matching identity is enough/);
    } finally {
      providers.getChatProvider = realGet;
    }
  });
});

describe("claude_agent autonomy gating", () => {
  const missions = require("../lib/missions");
  const realCreateMission = missions.createMission;
  const setLevel = (v) => stmts.setSetting.run(registry.AUTONOMY_KEY, v);

  it("off (default): not offered to the model and execute refuses", async () => {
    setLevel("off");
    assert.ok(!registry.geminiToolSpecs().some((s) => s.name === "claude_agent"));
    await assert.rejects(
      () => registry.get("claude_agent").execute({ task: "x" }, { source: "chat" }),
      /off - enable it/
    );
  });

  it("ask: offered, risk confirm, and chat needs a token (no execution)", async () => {
    setLevel("ask");
    assert.ok(registry.geminiToolSpecs().some((s) => s.name === "claude_agent"));
    assert.equal(registry.get("claude_agent").risk, "confirm");
    const out = await dispatch({ name: "claude_agent", params: { task: "x" }, source: "chat" });
    assert.equal(out.status, "needs_confirm");
    // siri (non-interactive) can never fire a confirm action.
    const siri = await dispatch({ name: "claude_agent", params: { task: "x" }, source: "siri" });
    assert.equal(siri.status, "denied");
  });

  it("auto: risk safe, fires inline even from siri", async () => {
    setLevel("auto");
    missions.createMission = async () => ({ id: "mission-stub" });
    try {
      assert.equal(registry.get("claude_agent").risk, "safe");
      const out = await dispatch({ name: "claude_agent", params: { task: "x" }, source: "siri" });
      assert.equal(out.status, "done");
      assert.equal(out.result.missionId, "mission-stub");
      assert.equal(out.result.view, "/missions/mission-stub");
    } finally {
      missions.createMission = realCreateMission;
      setLevel("off");
    }
  });
});

describe("browse gating (Phase Z, dynamic risk)", () => {
  const browser = require("../lib/browser");
  const realBrowse = browser.browse;
  const setSafe = (v) => stmts.setSetting.run(registry.BROWSE_KEY, v);
  const stub = async ({ query, url }) => ({ url: url || `search:${query}`, title: "T", frames: 1 });

  it("default: risk confirm; chat needs a token, siri is denied", async () => {
    setSafe("false");
    assert.equal(registry.get("browse").risk, "confirm");
    const chat = await dispatch({ name: "browse", params: { query: "cats" }, source: "chat" });
    assert.equal(chat.status, "needs_confirm");
    const siri = await dispatch({ name: "browse", params: { query: "cats" }, source: "siri" });
    assert.equal(siri.status, "denied");
  });

  it("opted-in: risk safe; fires inline (even from siri) - needs LEGACY_SURFACES (Phase AF)", async () => {
    setSafe("true");
    browser.browse = stub;
    process.env.LEGACY_SURFACES = "1";
    try {
      assert.equal(registry.get("browse").risk, "safe");
      const out = await dispatch({ name: "browse", params: { query: "cats" }, source: "siri" });
      assert.equal(out.status, "done");
      assert.equal(out.result.view, "/browse");
    } finally {
      browser.browse = realBrowse;
      setSafe("false");
      delete process.env.LEGACY_SURFACES;
    }
  });

  it("needs a query or a url", () => {
    assert.equal(browser.toUrl("", ""), null);
    assert.ok(browser.toUrl("cats", "").startsWith("https://www.google.com/search?q="));
    assert.equal(browser.toUrl("", "example.com"), "https://example.com");
  });

  it("open_browser (Tier 0): same gate; builds the target from query/url", () => {
    setSafe("false");
    assert.equal(registry.get("open_browser").risk, "confirm");
    setSafe("true");
    assert.equal(registry.get("open_browser").risk, "safe");
    // The URL it would hand to `open` comes from the shared resolver.
    assert.ok(browser.toUrl("DS 9 blue", "").startsWith("https://www.google.com/search?q="));
    setSafe("false");
  });
});

describe("computer_use gating (Phase Z Tier 2, dynamic risk - own opt-in)", () => {
  const computerUse = require("../lib/computer-use");
  const realComputerUse = computerUse.computerUse;
  const setSafe = (v) => stmts.setSetting.run(registry.COMPUTER_USE_KEY, v);
  const stub = async ({ steps } = {}) => ({ steps: Array.isArray(steps) ? steps.length : 1 });

  it("default: risk confirm; chat needs a token, siri is denied", async () => {
    setSafe("false");
    assert.equal(registry.get("computer_use").risk, "confirm");
    const chat = await dispatch({ name: "computer_use", params: {}, source: "chat" });
    assert.equal(chat.status, "needs_confirm");
    const siri = await dispatch({ name: "computer_use", params: {}, source: "siri" });
    assert.equal(siri.status, "denied");
  });

  it("is gated independently from `browse` (opting one in does not opt in the other)", async () => {
    stmts.setSetting.run(registry.BROWSE_KEY, "true");
    try {
      assert.equal(registry.get("computer_use").risk, "confirm");
    } finally {
      stmts.setSetting.run(registry.BROWSE_KEY, "false");
    }
  });

  it("opted-in: risk safe; fires inline even from siri", async () => {
    setSafe("true");
    computerUse.computerUse = stub;
    try {
      assert.equal(registry.get("computer_use").risk, "safe");
      const out = await dispatch({
        name: "computer_use",
        params: { steps: [{ type: "click", x: 1, y: 2 }] },
        source: "siri",
      });
      assert.equal(out.status, "done");
      assert.equal(out.result.steps, 1);
      assert.equal(out.result.view, "/computer-use");
    } finally {
      computerUse.computerUse = realComputerUse;
      setSafe("false");
    }
  });
});

describe("computer-use primitives (Phase Z Tier 2)", () => {
  const { escapeAppleScriptString } = require("../lib/computer-use");

  it("escapes backslashes and double quotes for an AppleScript string literal", () => {
    assert.equal(escapeAppleScriptString('say "hi"'), 'say \\"hi\\"');
    assert.equal(escapeAppleScriptString("C:\\path"), "C:\\\\path");
    assert.equal(escapeAppleScriptString(""), "");
  });

  it("is non-macOS honest: computerUse() rejects on other platforms", async (t) => {
    if (process.platform === "darwin") {
      t.skip("this suite runs on macOS - platform guard exercised implicitly");
      return;
    }
    const { computerUse } = require("../lib/computer-use");
    await assert.rejects(() => computerUse({}), /only works on macOS/);
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

  it("finishes a CLI fire-and-forget action in one provider call", async () => {
    let rounds = 0;
    const fake = {
      capabilities: { tools: true, promptTools: true },
      async callWithTools() {
        rounds++;
        return {
          text: "HUD updated.",
          toolCalls: [{ name: "set_hud_mode", args: { mode: "jarvis" } }],
        };
      },
    };
    const out = await runWithTools({
      providerMod: fake,
      messages: [{ role: "user", content: "enable jarvis" }],
      source: "chat",
    });
    assert.equal(rounds, 1);
    assert.equal(out.text, "HUD updated.");
    assert.equal(out.actions[0].status, "done");
  });

  it("a done action naming a view gets a companion navigate (deep-link)", async () => {
    const browser = require("../lib/browser");
    const realBrowse = browser.browse;
    browser.browse = async () => ({ url: "https://x", title: "X", frames: 1, view: "/browse" });
    stmts.setSetting.run(registry.BROWSE_KEY, "true"); // browse → safe, runs inline
    process.env.LEGACY_SURFACES = "1"; // browse is retired (Phase AF) unless resurrected
    try {
      const fake = {
        capabilities: { tools: true },
        isConfigured: () => true,
        async callWithTools(messages) {
          const answered = messages.some((m) => m.role === "tool");
          return answered
            ? { text: "Opened it.", toolCalls: [] }
            : { text: "", toolCalls: [{ name: "browse", args: { query: "cats" } }] };
        },
      };
      const out = await runWithTools({
        providerMod: fake,
        messages: [{ role: "user", content: "show me cats" }],
        source: "chat",
      });
      const nav = out.actions.find((a) => a.name === "navigate");
      assert.ok(nav, "a navigate action must follow the browse");
      assert.equal(nav.params.to, "/browse");
      assert.equal(nav.status, "done");
    } finally {
      browser.browse = realBrowse;
      stmts.setSetting.run(registry.BROWSE_KEY, "false");
      delete process.env.LEGACY_SURFACES;
    }
  });

  it("the retired browse surface refuses unless LEGACY_SURFACES=1", async () => {
    delete process.env.LEGACY_SURFACES;
    const browse = registry.get("browse");
    await assert.rejects(
      () => browse.execute({ query: "cats" }),
      (err) => err.code === "ERETIRED" && /RustDesk/.test(err.message)
    );
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
  it("maps deterministic task tiers to subscription models", () => {
    assert.equal(actions.selectModel("groq", "simple"), "openai/gpt-oss-20b");
    assert.equal(actions.selectModel("groq", "complex"), "openai/gpt-oss-120b");
    assert.equal(actions.selectModel("codex", "simple"), "gpt-5.6-luna");
    assert.equal(actions.selectModel("codex", "standard"), "gpt-5.6-terra");
    assert.equal(actions.selectModel("codex", "complex"), "gpt-5.6-sol");
    assert.equal(actions.selectModel("claude", "simple"), "haiku");
    assert.equal(actions.selectModel("claude", "standard"), "sonnet");
    assert.equal(actions.selectModel("claude", "complex"), "opus");
  });

  it("parses a bare directive and strips it", () => {
    assert.deepEqual(actions.parseProviderDirective("use claude"), {
      provider: "claude",
      remainder: "",
    });
    const d = actions.parseProviderDirective("switch to gemini and what's running");
    assert.equal(d.provider, "gemini");
    assert.match(d.remainder, /what's running/);
    assert.equal(actions.parseProviderDirective("hello there"), null);
    assert.deepEqual(actions.parseProviderDirective("use GPT"), {
      provider: "codex",
      remainder: "",
    });
    assert.equal(actions.parseProviderDirective("answer with ChatGPT please").provider, "codex");
    assert.equal(actions.parseProviderDirective("use groq").provider, "groq");
    assert.equal(actions.parseProviderDirective("use openai").provider, "openai");
  });

  it("automatically routes routine, complex, and multimodal work", () => {
    assert.equal(actions.selectAutomaticProvider("hello", "simple"), "groq");
    assert.equal(actions.selectAutomaticProvider("write an email", "standard"), "groq");
    assert.equal(
      actions.selectAutomaticProvider("what is Karan's DOB", "simple", { vaultGrounded: true }),
      "codex"
    );
    assert.equal(actions.selectAutomaticProvider("architect this", "complex"), "codex");
    assert.equal(actions.selectAutomaticProvider("open up my github", "simple"), "gemini");
    assert.equal(actions.selectAutomaticProvider("launch Spotify", "simple"), "gemini");
    assert.equal(
      actions.selectAutomaticProvider("do this", "simple", { requiresTools: true }),
      "gemini"
    );
    assert.equal(
      actions.selectAutomaticProvider("describe this", "simple", { hasImage: true }),
      "gemini"
    );
    assert.equal(actions.selectAutomaticProvider("x".repeat(6_001), "complex"), "gemini");
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

  it("kill with no active missions replies honestly", async () => {
    const res = await handleAsk({ text: "kill all", source: "siri" });
    assert.equal(res.intent, "kill");
    assert.match(res.text, /no active missions/);
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
