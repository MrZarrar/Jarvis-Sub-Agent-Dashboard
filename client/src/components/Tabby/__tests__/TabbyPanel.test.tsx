import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { TabbyPanel } from "../TabbyPanel";
import { BrainLockProvider, useBrainLockAccess } from "../../BrainLockGate";
import type { TabbyStatus } from "../brain";

// Mock the API surface the panel talks to (Phase M2).
vi.mock("../../../lib/api", () => ({
  api: {
    chat: { providers: vi.fn().mockResolvedValue({ providers: [] }) },
    assistant: { ask: vi.fn(), action: vi.fn() },
    brainLock: {
      status: vi.fn(),
      unlock: vi.fn(),
      setup: vi.fn(),
      lock: vi.fn(),
      settings: vi.fn(),
    },
  },
}));

import { api } from "../../../lib/api";
const askMock = api.assistant.ask as unknown as ReturnType<typeof vi.fn>;
const actionMock = api.assistant.action as unknown as ReturnType<typeof vi.fn>;
const providersMock = api.chat.providers as unknown as ReturnType<typeof vi.fn>;
const brainStatusMock = api.brainLock.status as unknown as ReturnType<typeof vi.fn>;
const brainUnlockMock = api.brainLock.unlock as unknown as ReturnType<typeof vi.fn>;

const STATUS: TabbyStatus = { liveCount: 0, waitingCount: 0, errorCount: 0, connected: true };

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof TabbyPanel>> = {},
  observer?: ReactNode
) {
  const props = {
    status: STATUS,
    muted: false,
    onToggleMute: vi.fn(),
    asleep: false,
    onToggleSleep: vi.fn(),
    onClearAlerts: vi.fn(),
    onNavigate: vi.fn(),
    onClientAction: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const view = render(
    <BrainLockProvider>
      <TabbyPanel {...props} />
      {observer}
    </BrainLockProvider>
  );
  return Object.assign(props, view);
}

function ask(text: string) {
  const input = screen.getByLabelText(/ask jarvis/i);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest("form")!);
}

function lockedStatus() {
  return {
    configured: true,
    unlocked: false,
    timeoutMinutes: 5,
    lockoutRemainingSeconds: 0,
  };
}

function privacySpies() {
  const location = window.location.href;
  return {
    local: vi.spyOn(localStorage, "setItem"),
    session: vi.spyOn(sessionStorage, "setItem"),
    push: vi.spyOn(history, "pushState"),
    replace: vi.spyOn(history, "replaceState"),
    location,
  };
}

function expectNotPersisted(question: string, spies: ReturnType<typeof privacySpies>) {
  expect(spies.local.mock.calls.flat().join(" ")).not.toContain(question);
  expect(spies.session.mock.calls.flat().join(" ")).not.toContain(question);
  expect(spies.push).not.toHaveBeenCalled();
  expect(spies.replace).not.toHaveBeenCalled();
  expect(window.location.href).toBe(spies.location);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function OnLockRender({ settle }: { settle: () => void }) {
  const { state, accessRevision } = useBrainLockAccess();
  const initialRevision = useRef(accessRevision);
  if (state === "locked" && accessRevision > initialRevision.current) settle();
  return null;
}

beforeEach(() => {
  localStorage.clear();
  askMock.mockReset();
  actionMock.mockReset();
  providersMock.mockReset().mockResolvedValue({ providers: [] });
  brainStatusMock.mockReset().mockResolvedValue({ ...lockedStatus(), unlocked: true });
  brainUnlockMock.mockReset();
  (api.brainLock.setup as unknown as ReturnType<typeof vi.fn>).mockReset();
  (api.brainLock.lock as unknown as ReturnType<typeof vi.fn>)
    .mockReset()
    .mockResolvedValue({ locked: true });
  (api.brainLock.settings as unknown as ReturnType<typeof vi.fn>).mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TabbyPanel (Mini-JARVIS assistant surface)", () => {
  it("answers a status question instantly and offline (no server call)", () => {
    renderPanel({ status: { ...STATUS, liveCount: 2 } });
    ask("status");
    expect(screen.getByText(/live ·/i)).toBeInTheDocument();
    expect(askMock).not.toHaveBeenCalled();
  });

  it("executes a done client action from a reply (enable ultron flips the HUD)", async () => {
    askMock.mockResolvedValue({
      text: "Ultron online.",
      provider: "gemini",
      conversationId: "c1",
      actions: [{ name: "set_hud_mode", params: { mode: "ultron" }, status: "done" }],
    });
    const props = renderPanel();
    ask("enable ultron");
    await waitFor(() =>
      expect(props.onClientAction).toHaveBeenCalledWith("set_hud_mode", { mode: "ultron" })
    );
    expect(screen.getByText("Ultron online.")).toBeInTheDocument();
  });

  it("renders a confirm chip for needs_confirm and executes on tap", async () => {
    askMock.mockResolvedValue({
      text: "This spawns an agent.",
      provider: "gemini",
      conversationId: "c1",
      actions: [
        {
          name: "spawn_run",
          params: { prompt: "x" },
          status: "needs_confirm",
          confirmToken: "tok",
        },
      ],
    });
    actionMock.mockResolvedValue({
      status: "done",
      name: "spawn_run",
      side: "server",
      result: { id: "run123" },
    });
    const props = renderPanel();
    ask("build me a thing");
    const confirm = await screen.findByRole("button", { name: /^confirm$/i });
    fireEvent.click(confirm);
    expect(actionMock).toHaveBeenCalledWith({
      name: "spawn_run",
      params: { prompt: "x" },
      confirmToken: "tok",
    });
    const open = await screen.findByRole("button", { name: /open run/i });
    fireEvent.click(open);
    expect(props.onNavigate).toHaveBeenCalledWith("/run/run123");
  });

  it("shows the Brain PIN requirement when a confirmed action is challenged", async () => {
    askMock.mockResolvedValue({
      text: "That note is protected.",
      provider: "gemini",
      conversationId: "c1",
      actions: [
        {
          name: "vault_read",
          params: { id: "sensitive-note" },
          status: "needs_confirm",
          confirmToken: "tok",
        },
      ],
    });
    actionMock.mockResolvedValue({ pinRequired: true });

    renderPanel();
    ask("read the protected note");
    fireEvent.click(await screen.findByRole("button", { name: /^confirm$/i }));

    expect(
      await screen.findByText("Unlock the Brain with your PIN to access that note.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Not executed.")).not.toBeInTheDocument();
  });

  it("a typed-risk action requires retyping - does not fire on its own", async () => {
    askMock.mockResolvedValue({
      text: "That runs a shell command.",
      provider: "gemini",
      conversationId: "c1",
      actions: [
        { name: "shell", params: { cmd: "ls" }, status: "needs_confirm", requiresTyped: true },
      ],
    });
    renderPanel();
    ask("run ls");
    // A typed-confirm input appears; no server action has been dispatched.
    expect(await screen.findByPlaceholderText(/type "shell" to run/i)).toBeInTheDocument();
    expect(actionMock).not.toHaveBeenCalled();
  });

  it("syncs the provider picker to a spoken switch in the reply", async () => {
    askMock.mockResolvedValue({
      text: "Switched.",
      provider: "claude",
      conversationId: "c1",
      actions: [],
    });
    renderPanel();
    ask("use claude");
    await waitFor(() =>
      expect(localStorage.getItem("agent-dashboard-tabby-provider")).toBe("claude")
    );
  });

  it("retries a PIN-challenged question once after unlock without a duplicate bubble", async () => {
    const question = "What is in my private launch note?";
    brainStatusMock.mockResolvedValue(lockedStatus());
    brainUnlockMock.mockResolvedValue({ ...lockedStatus(), unlocked: true });
    askMock.mockResolvedValueOnce({ pinRequired: true }).mockResolvedValueOnce({
      text: "The launch note says proceed Friday.",
      provider: "gemini",
      conversationId: "c-private",
      actions: [],
    });
    renderPanel();
    const privacy = privacySpies();

    ask(question);
    const modal = await screen.findByRole("dialog", { name: "Brain locked" });
    expectNotPersisted(question, privacy);
    fireEvent.change(within(modal).getByLabelText("Four-digit PIN"), {
      target: { value: "2468" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: "Unlock sensitive notes" }));

    expect(await screen.findByText("The launch note says proceed Friday.")).toBeInTheDocument();
    expect(askMock).toHaveBeenCalledTimes(2);
    expect(askMock.mock.calls[0]?.[0]).toBe(question);
    expect(askMock.mock.calls[1]?.[0]).toBe(question);
    expect(screen.getAllByText(question)).toHaveLength(1);
  });

  it("clears a challenged question when unlock is cancelled", async () => {
    const question = "Read my private cancellation note";
    brainStatusMock.mockResolvedValue(lockedStatus());
    askMock.mockResolvedValue({ pinRequired: true });
    renderPanel();
    const privacy = privacySpies();

    ask(question);
    const modal = await screen.findByRole("dialog", { name: "Brain locked" });
    fireEvent.click(within(modal).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText(question)).not.toBeInTheDocument());
    expect(askMock).toHaveBeenCalledTimes(1);
    expectNotPersisted(question, privacy);
  });

  it("clears a challenged question after a wrong PIN", async () => {
    const question = "Read my private recipe note";
    brainStatusMock.mockResolvedValue(lockedStatus());
    brainUnlockMock.mockResolvedValue(lockedStatus());
    askMock.mockResolvedValue({ pinRequired: true });
    renderPanel();
    const privacy = privacySpies();

    ask(question);
    const modal = await screen.findByRole("dialog", { name: "Brain locked" });
    fireEvent.change(within(modal).getByLabelText("Four-digit PIN"), {
      target: { value: "1111" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: "Unlock sensitive notes" }));

    expect(await within(modal).findByText("PIN not recognised.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(question)).not.toBeInTheDocument());
    expect(askMock).toHaveBeenCalledTimes(1);
    expectNotPersisted(question, privacy);
  });

  it("stops after a second PIN challenge", async () => {
    const question = "Read my repeatedly protected note";
    brainStatusMock.mockResolvedValue(lockedStatus());
    brainUnlockMock.mockResolvedValue({ ...lockedStatus(), unlocked: true });
    askMock.mockResolvedValue({ pinRequired: true });
    renderPanel();
    const privacy = privacySpies();

    ask(question);
    const modal = await screen.findByRole("dialog", { name: "Brain locked" });
    fireEvent.change(within(modal).getByLabelText("Four-digit PIN"), {
      target: { value: "2468" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: "Unlock sensitive notes" }));

    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(question)).not.toBeInTheDocument();
    expectNotPersisted(question, privacy);
  });

  it("clears a challenged question on manual lock", async () => {
    const question = "Read my private lock note";
    brainStatusMock.mockResolvedValue(lockedStatus());
    askMock.mockResolvedValue({ pinRequired: true });
    renderPanel();
    const privacy = privacySpies();

    ask(question);
    await screen.findByRole("dialog", { name: "Brain locked" });
    act(() => window.dispatchEvent(new CustomEvent("jarvis:brain-locked")));

    await waitFor(() => expect(screen.queryByText(question)).not.toBeInTheDocument());
    expect(askMock).toHaveBeenCalledTimes(1);
    expectNotPersisted(question, privacy);
  });

  it("discards a deferred initial response that settles during a lock transition", async () => {
    const question = "Read my private travel note";
    const response = "The private trip begins on Saturday.";
    const pending = deferred<Awaited<ReturnType<typeof api.assistant.ask>>>();
    askMock.mockReturnValue(pending.promise);
    renderPanel(
      {},
      <OnLockRender
        settle={() =>
          pending.resolve({
            text: response,
            speech: response,
            intent: "chat",
            source: "chat",
            provider: "gemini",
            conversationId: "c-late-first",
            actions: [],
          })
        }
      />
    );
    const privacy = privacySpies();

    ask(question);
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new CustomEvent("jarvis:brain-locked"));

    await waitFor(() => expect(screen.queryByText(question)).not.toBeInTheDocument());
    expect(screen.queryByText(response)).not.toBeInTheDocument();
    expectNotPersisted(question, privacy);
    expectNotPersisted(response, privacy);
  });

  it("discards a deferred retry response that settles during a lock transition", async () => {
    const question = "Read my private itinerary note";
    const response = "The private itinerary includes York.";
    const retry = deferred<Awaited<ReturnType<typeof api.assistant.ask>>>();
    brainStatusMock.mockResolvedValue(lockedStatus());
    brainUnlockMock.mockResolvedValue({ ...lockedStatus(), unlocked: true });
    askMock.mockResolvedValueOnce({ pinRequired: true }).mockReturnValueOnce(retry.promise);
    renderPanel(
      {},
      <OnLockRender
        settle={() =>
          retry.resolve({
            text: response,
            speech: response,
            intent: "chat",
            source: "chat",
            provider: "gemini",
            conversationId: "c-late-retry",
            actions: [],
          })
        }
      />
    );
    const privacy = privacySpies();

    ask(question);
    const modal = await screen.findByRole("dialog", { name: "Brain locked" });
    fireEvent.change(within(modal).getByLabelText("Four-digit PIN"), {
      target: { value: "2468" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: "Unlock sensitive notes" }));
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(2));
    window.dispatchEvent(new CustomEvent("jarvis:brain-locked"));

    await waitFor(() => expect(screen.queryByText(question)).not.toBeInTheDocument());
    expect(screen.queryByText(response)).not.toBeInTheDocument();
    expectNotPersisted(question, privacy);
    expectNotPersisted(response, privacy);
  });

  it("clears a challenged question on unmount", async () => {
    const question = "Read my private unmount note";
    brainStatusMock.mockResolvedValue(lockedStatus());
    askMock.mockResolvedValue({ pinRequired: true });
    const panel = renderPanel();
    const privacy = privacySpies();

    ask(question);
    await screen.findByRole("dialog", { name: "Brain locked" });
    panel.unmount();

    expect(askMock).toHaveBeenCalledTimes(1);
    expectNotPersisted(question, privacy);
  });

  it("clears an in-flight question when the request fails", async () => {
    const question = "Read my private garden note";
    askMock.mockRejectedValue(new Error("Request failed"));
    renderPanel();
    const privacy = privacySpies();

    ask(question);

    expect(await screen.findByText(/Request failed/)).toBeInTheDocument();
    expect(screen.queryByText(question)).not.toBeInTheDocument();
    expect(askMock).toHaveBeenCalledTimes(1);
    expectNotPersisted(question, privacy);
  });
});
