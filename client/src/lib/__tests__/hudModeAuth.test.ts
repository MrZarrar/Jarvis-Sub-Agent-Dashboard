import { beforeEach, describe, expect, it, vi } from "vitest";

describe("hudMode dashboard authentication", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("includes the configured dashboard token when reporting a mode change", async () => {
    localStorage.setItem("dashboard_token", "outer-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const { hudMode } = await import("../hudMode");
    hudMode.setSetting("ultron");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/hud-mode",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-dashboard-token": "outer-token" }),
      })
    );
  });
});
