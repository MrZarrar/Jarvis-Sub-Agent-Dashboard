import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, streamChatMessage } from "../api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Brain Lock API boundary", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("broadcasts a global lock event when a protected request returns 423", async () => {
    const onLocked = vi.fn();
    window.addEventListener("jarvis:brain-locked", onLocked);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: "EBRAINLOCKED", message: "Brain is locked" } }, 423)
        )
    );

    await expect(api.notes.config()).rejects.toThrow("Brain is locked");

    expect(onLocked).toHaveBeenCalledOnce();
    window.removeEventListener("jarvis:brain-locked", onLocked);
  });

  it("exposes cookie-backed PIN endpoints without persisting PIN or session state client-side", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        configured: true,
        unlocked: true,
        timeoutMinutes: 5,
        lockoutRemainingSeconds: 0,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.brainLock.unlock("2468");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/brain-lock/unlock",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ pin: "2468" }) })
    );
    expect(Object.values(localStorage)).not.toContain("2468");
    expect(Object.values(sessionStorage)).not.toContain("2468");
    expect(window.location.href).not.toContain("2468");
    expect(localStorage.getItem("jarvis_brain_session")).toBeNull();
    expect(sessionStorage.getItem("jarvis_brain_session")).toBeNull();
    expect(window.location.href).not.toContain("jarvis_brain_session");
  });

  it("broadcasts the lock event when an active chat stream receives 423", async () => {
    const onLocked = vi.fn();
    window.addEventListener("jarvis:brain-locked", onLocked);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: "EBRAINLOCKED", message: "Brain is locked" } }, 423)
        )
    );

    await expect(streamChatMessage("chat-1", { text: "private" }, {})).rejects.toThrow(
      "Brain is locked"
    );

    expect(onLocked).toHaveBeenCalledOnce();
    window.removeEventListener("jarvis:brain-locked", onLocked);
  });

  it("keeps direct file uploads behind the outer dashboard token", async () => {
    localStorage.setItem("dashboard_token", "outer-token");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ imported: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.import.upload([new File(["test"], "history.jsonl")]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/import/upload",
      expect.objectContaining({
        headers: { "x-dashboard-token": "outer-token" },
      })
    );
  });
});
