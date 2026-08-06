const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  callWithToolsViaChat,
  parseToolResponse,
  textMessages,
} = require("../lib/providers/cli-tools");

describe("CLI provider Jarvis action protocol", () => {
  it("parses structured action requests and tolerates fenced JSON", () => {
    assert.deepEqual(
      parseToolResponse(
        '```json\n{"text":"Opening.","toolCalls":[{"name":"open_browser","args":{"url":"https://github.com"}}]}\n```'
      ),
      {
        text: "Opening.",
        toolCalls: [{ name: "open_browser", args: { url: "https://github.com" } }],
      }
    );
  });

  it("falls back to a normal text answer when a CLI ignores the protocol", () => {
    assert.deepEqual(parseToolResponse("Just a normal answer."), {
      text: "Just a normal answer.",
      toolCalls: [],
    });
  });

  it("uses the first complete object when a CLI appends diagnostics", () => {
    assert.deepEqual(
      parseToolResponse(
        '{"text":"Opening.","toolCalls":[{"name":"open_browser","args":{}}]}' +
          '{"text":"hook diagnostic","toolCalls":[]}'
      ),
      {
        text: "Opening.",
        toolCalls: [{ name: "open_browser", args: {} }],
      }
    );
  });

  it("replays action requests and results as text for stateless CLIs", async () => {
    let received;
    let receivedOpts;
    async function* stream(messages, opts) {
      received = messages;
      receivedOpts = opts;
      yield { text: '{"text":"All quiet.","toolCalls":[]}' };
    }

    const out = await callWithToolsViaChat(
      stream,
      [
        { role: "system", content: "Be concise." },
        { role: "assistant", content: "", toolCalls: [{ name: "get_status", args: {} }] },
        { role: "tool", name: "get_status", content: '{"ok":true}' },
      ],
      [{ name: "get_status" }]
    );

    assert.equal(out.text, "All quiet.");
    assert.equal(receivedOpts.disableNativeTools, true);
    assert.match(received[0].content, /Available actions:/);
    assert.match(received[1].content, /Jarvis action requests/);
    assert.match(received[2].content, /Jarvis action result for get_status/);
  });

  it("adds a protocol system message when the conversation has none", () => {
    const messages = textMessages([{ role: "user", content: "hello" }], []);
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /permission gate/);
  });
});
