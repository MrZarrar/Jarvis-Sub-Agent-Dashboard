import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BrainLockControls,
  BrainLockProvider,
  shouldLockAfterResume,
  useBrainLock,
} from "../BrainLockGate";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const lockedStatus = {
  configured: true,
  unlocked: false,
  timeoutMinutes: 5 as const,
  lockoutRemainingSeconds: 0,
};

const unlockedStatus = { ...lockedStatus, unlocked: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function TestDashboard() {
  const brainLock = useBrainLock();
  return (
    <>
      <div>Operational dashboard</div>
      <output aria-label="Brain state">{brainLock.state}</output>
      <button
        type="button"
        onClick={() => {
          void brainLock.requestUnlock().then((unlocked) => {
            document.body.dataset.unlockResult = String(unlocked);
          });
        }}
      >
        Request protected action
      </button>
      <BrainLockControls />
    </>
  );
}

function renderDashboard() {
  return render(
    <BrainLockProvider>
      <TestDashboard />
    </BrainLockProvider>
  );
}

describe("BrainLockProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    delete document.body.dataset.unlockResult;
    window.history.replaceState({}, "", "/");
    vi.restoreAllMocks();
  });

  it("keeps the operational dashboard mounted while sensitive notes are locked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(lockedStatus)));

    renderDashboard();

    expect(await screen.findByText("Operational dashboard")).toBeVisible();
    expect(await screen.findByLabelText("Brain state")).toHaveTextContent("locked");
    expect(screen.getByRole("button", { name: "Unlock sensitive notes" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens one accessible modal and resolves an unlock request after server confirmation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      return jsonResponse(String(input).endsWith("/unlock") ? unlockedStatus : lockedStatus);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "Request protected action" }));
    const dialog = screen.getByRole("dialog", { name: "Brain locked" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    await user.type(screen.getByLabelText("Four-digit PIN"), "2468");
    await user.click(within(dialog).getByRole("button", { name: "Unlock sensitive notes" }));

    await waitFor(() => expect(document.body.dataset.unlockResult).toBe("true"));
    expect(screen.getByLabelText("Brain state")).toHaveTextContent("unlocked");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lock sensitive notes" })).toBeVisible();
  });

  it("resolves an unlock request made while initial status is loading", async () => {
    const status = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(status.promise));
    const user = userEvent.setup();
    renderDashboard();

    await user.click(screen.getByRole("button", { name: "Request protected action" }));
    expect(screen.getByRole("dialog", { name: "Brain locked" })).toBeVisible();

    status.resolve(jsonResponse(unlockedStatus));

    await waitFor(() => expect(document.body.dataset.unlockResult).toBe("true"));
    expect(screen.getByLabelText("Brain state")).toHaveTextContent("unlocked");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("contains keyboard focus in the modal and restores the opener on cancel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(lockedStatus)));
    const user = userEvent.setup();
    renderDashboard();

    const opener = await screen.findByRole("button", { name: "Unlock sensitive notes" });
    opener.focus();
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Brain locked" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const submit = within(dialog).getByRole("button", { name: "Unlock sensitive notes" });

    submit.focus();
    await user.tab();
    expect(cancel).toHaveFocus();

    cancel.focus();
    await user.tab({ shift: true });
    expect(submit).toHaveFocus();

    await user.click(cancel);
    expect(opener).toHaveFocus();
  });

  it("resolves a pending unlock request false when the modal is cancelled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(lockedStatus)));
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "Request protected action" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(document.body.dataset.unlockResult).toBe("false"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("resolves false after an invalid PIN response and exposes lockout locally", async () => {
    const lockedOutStatus = { ...lockedStatus, lockoutRemainingSeconds: 900 };
    let unlockRejected = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/unlock")) {
        unlockRejected = true;
        return jsonResponse({ error: { message: "PIN not recognised" } }, 401);
      }
      return jsonResponse(unlockRejected ? lockedOutStatus : lockedStatus);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "Request protected action" }));
    await user.type(screen.getByLabelText("Four-digit PIN"), "1111");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unlock sensitive notes",
      })
    );

    await waitFor(() => expect(document.body.dataset.unlockResult).toBe("false"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Too many attempts. Try again when the timer ends."
    );
    expect(screen.getByText("Try again in 15:00")).toBeVisible();
    expect(screen.getByText("Operational dashboard")).toBeVisible();
  });

  it("manually locks, clears sensitive previews, and leaves the dashboard mounted", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/lock")) return jsonResponse({ locked: true });
      return jsonResponse(unlockedStatus);
    });
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("agent-dashboard-tabby-convo", '{"text":"private"}');
    localStorage.setItem("sidebar-connection-stats", '{"recent":["Private mission"]}');
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "Lock sensitive notes" }));

    expect(await screen.findByLabelText("Brain state")).toHaveTextContent("locked");
    expect(screen.getByText("Operational dashboard")).toBeVisible();
    expect(localStorage.getItem("agent-dashboard-tabby-convo")).toBeNull();
    expect(localStorage.getItem("sidebar-connection-stats")).toBeNull();
  });

  it("still locks in memory when browser storage is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/lock")) return jsonResponse({ locked: true });
      return jsonResponse(unlockedStatus);
    });
    vi.stubGlobal("fetch", fetchMock);
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const user = userEvent.setup();

    try {
      renderDashboard();
      await user.click(await screen.findByRole("button", { name: "Lock sensitive notes" }));

      expect(screen.getByLabelText("Brain state")).toHaveTextContent("locked");
      expect(screen.getByText("Operational dashboard")).toBeVisible();
    } finally {
      removeItem.mockRestore();
    }
  });

  it("resolves a pending request false when a protected call reports status loss", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(lockedStatus)));
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "Request protected action" }));
    fireEvent(window, new CustomEvent("jarvis:brain-locked"));

    await waitFor(() => expect(document.body.dataset.unlockResult).toBe("false"));
    expect(screen.getByLabelText("Brain state")).toHaveTextContent("locked");
    expect(screen.getByText("Operational dashboard")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("updates to locked after inactivity without unmounting children", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/lock")) return jsonResponse({ locked: true });
      return jsonResponse({ ...unlockedStatus, timeoutMinutes: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      renderDashboard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByLabelText("Brain state")).toHaveTextContent("unlocked");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(screen.getByLabelText("Brain state")).toHaveTextContent("locked");
      expect(screen.getByText("Operational dashboard")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the dashboard available when lock status cannot be checked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();
    renderDashboard();

    expect(await screen.findByText("Operational dashboard")).toBeVisible();
    expect(await screen.findByLabelText("Brain state")).toHaveTextContent("unavailable");
    await user.click(screen.getByRole("button", { name: "Request protected action" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    await waitFor(() => expect(document.body.dataset.unlockResult).toBe("false"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The lock service is unavailable. Check the dashboard connection."
    );
  });

  it("does not put a submitted PIN or session identifier in browser storage or the URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      return jsonResponse(String(input).endsWith("/unlock") ? unlockedStatus : lockedStatus);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "Unlock sensitive notes" }));
    await user.type(screen.getByLabelText("Four-digit PIN"), "2468");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unlock sensitive notes",
      })
    );
    await screen.findByRole("button", { name: "Lock sensitive notes" });

    expect(JSON.stringify(Object.entries(localStorage))).not.toContain("2468");
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain("2468");
    expect(window.location.href).not.toContain("2468");
    expect(localStorage.getItem("jarvis_brain_session")).toBeNull();
    expect(sessionStorage.getItem("jarvis_brain_session")).toBeNull();
    expect(window.location.href).not.toContain("jarvis_brain_session");
  });

  it("detects a resume after the configured inactivity window", () => {
    expect(shouldLockAfterResume(1_000, 61_001, 1)).toBe(true);
    expect(shouldLockAfterResume(1_000, 60_999, 1)).toBe(false);
    expect(shouldLockAfterResume(null, 61_001, 1)).toBe(false);
  });
});
