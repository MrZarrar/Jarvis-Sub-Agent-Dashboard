/**
 * @file providers-gemini.test.js
 * @description Regression test for the Gemini 3 `thoughtSignature` bugfix: the
 * function-calling adapter (`server/lib/providers/gemini.js`) must capture the
 * `thoughtSignature` Gemini attaches to a functionCall part and echo it back on
 * the model's turn in the NEXT round's request body - omitting it makes Gemini
 * 3 models 400 with "missing a thought_signature" (discovered live: mini-Jarvis
 * could ask Gemini "what are my agents doing", Gemini would call `get_status`,
 * and the follow-up round would fail, silently falling back to another
 * provider). `fetch` is stubbed; no network call is made.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-provider-test-"));
process.env.PROVIDERS_CONFIG_PATH = path.join(TMP, "providers.json");
fs.writeFileSync(
  process.env.PROVIDERS_CONFIG_PATH,
  JSON.stringify({ gemini: { enabled: true, apiKey: "test-key" } })
);

const gemini = require("../lib/providers/gemini");

const THOUGHT_SIGNATURE = "sig-abc-123";

describe("gemini callWithTools: thoughtSignature passthrough", () => {
  let originalFetch;
  let capturedBody;

  before(() => {
    originalFetch = global.fetch;
  });
  after(() => {
    global.fetch = originalFetch;
  });

  it("captures the thoughtSignature on a functionCall and echoes it back next round", async () => {
    let call = 0;
    global.fetch = async (_url, opts) => {
      call += 1;
      if (call === 1) {
        // First round: Gemini calls a tool, attaching a thoughtSignature.
        return {
          ok: true,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: "get_status", args: {} },
                      thoughtSignature: THOUGHT_SIGNATURE,
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      // Second round: capture what we sent back, then answer in plain text.
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "all good" }] } }],
        }),
      };
    };

    const messages1 = [{ role: "user", content: "what's running?" }];
    const first = await gemini.callWithTools(messages1, [{ name: "get_status" }]);
    assert.equal(first.toolCalls.length, 1);
    assert.equal(first.toolCalls[0].thoughtSignature, THOUGHT_SIGNATURE);

    // Mirror what agent-loop.js does: record the model's tool-call turn, then
    // the tool result, and ask again.
    const messages2 = [
      ...messages1,
      { role: "assistant", content: first.text, toolCalls: first.toolCalls },
      { role: "tool", name: "get_status", response: { ok: true } },
    ];
    const second = await gemini.callWithTools(messages2, [{ name: "get_status" }]);
    assert.equal(second.text, "all good");

    // The critical assertion: the request we just sent echoed the signature
    // back on the model's functionCall part - this is what Gemini 3 requires.
    const modelTurn = capturedBody.contents.find((c) => c.role === "model");
    const fcPart = modelTurn.parts.find((p) => p.functionCall);
    assert.equal(fcPart.thoughtSignature, THOUGHT_SIGNATURE);
  });

  it("omits thoughtSignature cleanly when the model doesn't return one (older models)", async () => {
    let call = 0;
    global.fetch = async (_url, opts) => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({
            candidates: [
              { content: { parts: [{ functionCall: { name: "get_status", args: {} } }] } },
            ],
          }),
        };
      }
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
      };
    };

    const messages1 = [{ role: "user", content: "hi" }];
    const first = await gemini.callWithTools(messages1, [{ name: "get_status" }]);
    assert.equal(first.toolCalls[0].thoughtSignature, undefined);

    const messages2 = [
      ...messages1,
      { role: "assistant", content: first.text, toolCalls: first.toolCalls },
      { role: "tool", name: "get_status", response: { ok: true } },
    ];
    await gemini.callWithTools(messages2, [{ name: "get_status" }]);
    const modelTurn = capturedBody.contents.find((c) => c.role === "model");
    const fcPart = modelTurn.parts.find((p) => p.functionCall);
    assert.ok(!("thoughtSignature" in fcPart), "no stray thoughtSignature key when none was given");
  });
});
