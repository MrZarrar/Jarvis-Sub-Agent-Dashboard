import { beforeEach, describe, expect, it, vi } from "vitest";

describe("work mode", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("defaults to dev and persists an explicit business mode", async () => {
    const workMode = await import("../workMode");
    expect(workMode.getWorkMode()).toBe("dev");

    workMode.setWorkMode("business");

    expect(workMode.getWorkMode()).toBe("business");
    expect(localStorage.getItem("work-mode")).toBe("business");
  });

  it("publishes changes so mounted surfaces can refresh", async () => {
    const workMode = await import("../workMode");
    const listener = vi.fn();
    window.addEventListener("work:modechange", listener);

    workMode.setWorkMode("business");

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("work:modechange", listener);
  });
});
