import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ComputerUse from "../ComputerUse";

const { snapshot } = vi.hoisted(() => ({
  snapshot: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../lib/api", () => ({
  api: {
    assistant: {
      computerUseLast: vi.fn().mockResolvedValue({ frame: null }),
      computerUseSnapshot: snapshot,
    },
  },
}));

vi.mock("../../lib/eventBus", () => ({
  eventBus: { subscribe: vi.fn(() => () => {}) },
}));

describe("Mac snapshot view", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    snapshot.mockClear();
    window.history.replaceState({}, "", "/computer-use?live=1");
  });

  afterEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.useRealTimers();
  });

  it("captures every second and stops when unmounted", async () => {
    const view = render(<ComputerUse />);
    await act(async () => {});
    expect(snapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(snapshot).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(snapshot).toHaveBeenCalledTimes(2);

    view.unmount();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
});
