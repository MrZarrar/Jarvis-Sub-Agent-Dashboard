import { describe, expect, it } from "vitest";
import { providerForResume, sessionIdForResume } from "../runProvider";

describe("run provider resume helpers", () => {
  it("keeps Claude session ids unchanged", () => {
    expect(sessionIdForResume({ id: "claude-session", provider: "claude", metadata: null })).toBe(
      "claude-session"
    );
  });

  it("uses the native Codex thread id stored in session metadata", () => {
    expect(
      sessionIdForResume({
        id: "codex-dashboard-id",
        provider: "codex",
        metadata: JSON.stringify({ threadId: "019f-native-thread" }),
      })
    ).toBe("019f-native-thread");
  });

  it("falls back to stripping the dashboard Codex prefix", () => {
    expect(
      sessionIdForResume({ id: "codex-019f-fallback", provider: "codex", metadata: "invalid" })
    ).toBe("019f-fallback");
  });

  it("uses the resumed provider and otherwise keeps the selected provider", () => {
    expect(providerForResume({ provider: "codex" }, "claude")).toBe("codex");
    expect(providerForResume({}, "gemini-cli")).toBe("gemini-cli");
  });
});
