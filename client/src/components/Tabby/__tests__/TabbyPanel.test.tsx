import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { TabbyPanel } from "../TabbyPanel";
import type { TabbyStatus } from "../brain";

// Mock the API surface the panel talks to (Phase M2).
vi.mock("../../../lib/api", () => ({
  api: {
    chat: { providers: vi.fn().mockResolvedValue({ providers: [] }) },
    assistant: { ask: vi.fn(), action: vi.fn() },
  },
}));

import { api } from "../../../lib/api";
const askMock = api.assistant.ask as unknown as ReturnType<typeof vi.fn>;
const actionMock = api.assistant.action as unknown as ReturnType<typeof vi.fn>;
const providersMock = api.chat.providers as unknown as ReturnType<typeof vi.fn>;

const STATUS: TabbyStatus = { liveCount: 0, waitingCount: 0, errorCount: 0, connected: true };

function renderPanel(overrides: Partial<React.ComponentProps<typeof TabbyPanel>> = {}) {
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
  render(<TabbyPanel {...props} />);
  return props;
}

function ask(text: string) {
  const input = screen.getByLabelText(/ask jarvis/i);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest("form")!);
}

beforeEach(() => {
  localStorage.clear();
  askMock.mockReset();
  actionMock.mockReset();
  providersMock.mockReset();
  providersMock.mockResolvedValue({ providers: [] });
});
afterEach(cleanup);

describe("TabbyPanel (Mini-JARVIS assistant surface)", () => {
  it("defaults to automatic routing and offers Groq", async () => {
    providersMock.mockResolvedValue({
      providers: [
        {
          id: "groq",
          label: "Groq",
          configured: true,
          enabled: true,
          capabilities: { chat: true, image: false, tools: true },
          models: [],
          defaultModel: "openai/gpt-oss-20b",
        },
      ],
    });
    askMock.mockResolvedValue({
      text: "Hello.",
      provider: "groq",
      conversationId: "c1",
      actions: [],
    });
    renderPanel();
    const select = await screen.findByLabelText("Assistant provider");
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: "Groq" })).toBeInTheDocument();
    ask("hello");
    await waitFor(() => expect(askMock).toHaveBeenCalled());
    const [, options] = askMock.mock.calls[0]!;
    expect(options.provider).toBeUndefined();
  });

  it("offers subscription-backed GPT when Codex is enabled", async () => {
    providersMock.mockResolvedValue({
      providers: [
        {
          id: "codex",
          label: "GPT (Codex)",
          configured: true,
          enabled: true,
          capabilities: { chat: true, image: false },
          models: [],
          defaultModel: "default",
        },
      ],
    });
    renderPanel();
    expect(await screen.findByRole("option", { name: "GPT (Codex)" })).toBeInTheDocument();
  });

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
      result: { id: "mission123" },
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
    const open = await screen.findByRole("button", { name: /open mission/i });
    fireEvent.click(open);
    expect(props.onNavigate).toHaveBeenCalledWith("/missions/mission123");
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

  it("syncs a spoken GPT switch to the Codex subscription provider", async () => {
    askMock.mockResolvedValue({
      text: "Switched to GPT via Codex.",
      provider: "codex",
      conversationId: "c1",
      actions: [],
    });
    renderPanel();
    ask("use GPT");
    await waitFor(() =>
      expect(localStorage.getItem("agent-dashboard-tabby-provider")).toBe("codex")
    );
  });
});
