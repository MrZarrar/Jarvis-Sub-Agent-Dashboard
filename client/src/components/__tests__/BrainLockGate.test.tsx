import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrainLockGate, shouldLockAfterResume } from "../BrainLockGate";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const lockedStatus = {
  configured: true,
  unlocked: false,
  timeoutMinutes: 5,
  lockoutRemainingSeconds: 0,
};

const unlockedStatus = { ...lockedStatus, unlocked: true };

describe("BrainLockGate", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows a neutral locked panel without mounting sensitive children", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(lockedStatus)));

    render(
      <BrainLockGate>
        <div>Private note preview</div>
      </BrainLockGate>
    );

    expect(await screen.findByRole("heading", { name: "Brain locked" })).toBeInTheDocument();
    expect(screen.queryByText("Private note preview")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Four-digit PIN")).toHaveAttribute("inputmode", "numeric");
  });

  it("mounts the dashboard only after this device unlocks", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return jsonResponse(url.endsWith("/unlock") ? unlockedStatus : lockedStatus);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <BrainLockGate>
        <div>Private note preview</div>
      </BrainLockGate>
    );
    await user.type(await screen.findByLabelText("Four-digit PIN"), "2468");
    await user.click(screen.getByRole("button", { name: "Unlock brain" }));

    expect(await screen.findByText("Private note preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lock brain" })).toBeInTheDocument();
  });

  it("clears persisted previews and unmounts the dashboard on a global 423", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(unlockedStatus)));
    localStorage.setItem("agent-dashboard-tabby-convo", '{"text":"private"}');
    localStorage.setItem("sidebar-connection-stats", '{"recent":["Private mission"]}');

    render(
      <BrainLockGate>
        <div>Private note preview</div>
      </BrainLockGate>
    );
    expect(await screen.findByText("Private note preview")).toBeInTheDocument();

    fireEvent(window, new CustomEvent("jarvis:brain-locked"));

    await waitFor(() => {
      expect(screen.queryByText("Private note preview")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Brain locked" })).toBeInTheDocument();
    expect(localStorage.getItem("agent-dashboard-tabby-convo")).toBeNull();
    expect(localStorage.getItem("sidebar-connection-stats")).toBeNull();
  });

  it("still hides sensitive children when browser storage is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(unlockedStatus)));
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    render(
      <BrainLockGate>
        <div>Private note preview</div>
      </BrainLockGate>
    );
    expect(await screen.findByText("Private note preview")).toBeInTheDocument();

    fireEvent(window, new CustomEvent("jarvis:brain-locked"));

    expect(await screen.findByRole("heading", { name: "Brain locked" })).toBeInTheDocument();
    expect(screen.queryByText("Private note preview")).not.toBeInTheDocument();
    removeItem.mockRestore();
  });

  it("keeps a connection error visible when lock status cannot be checked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(
      <BrainLockGate>
        <div>Private note preview</div>
      </BrainLockGate>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The lock service is unavailable. Check the dashboard connection."
    );
    expect(screen.queryByText("Private note preview")).not.toBeInTheDocument();
  });

  it("manually locks and clears the current device", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/lock")) return jsonResponse({ locked: true });
      return jsonResponse(unlockedStatus);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <BrainLockGate>
        <div>Private note preview</div>
      </BrainLockGate>
    );
    await user.click(await screen.findByRole("button", { name: "Lock brain" }));

    expect(await screen.findByRole("heading", { name: "Brain locked" })).toBeInTheDocument();
    expect(screen.queryByText("Private note preview")).not.toBeInTheDocument();
  });

  it("detects a resume after the configured inactivity window", () => {
    expect(shouldLockAfterResume(1_000, 61_001, 1)).toBe(true);
    expect(shouldLockAfterResume(1_000, 60_999, 1)).toBe(false);
    expect(shouldLockAfterResume(null, 61_001, 1)).toBe(false);
  });
});
