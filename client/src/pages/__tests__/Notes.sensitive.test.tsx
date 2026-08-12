import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BrainLockControls, BrainLockProvider } from "../../components/BrainLockGate";
import { Notes } from "../Notes";
import { Vault } from "../Vault";
import type { Note } from "../../lib/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const note: Note = {
  id: "note-1",
  path: "projects/secret.md",
  title: "Secret plan",
  tags: ["private"],
  projectId: null,
  source: "manual",
  excerpt: "Protected details",
  sensitive: true,
  mtime: "2026-08-12T12:00:00.000Z",
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:00:00.000Z",
  body: "Protected details",
};

function noteMeta(item: Note) {
  const { body: _body, ...meta } = item;
  return meta;
}

function notesPage() {
  return render(
    <BrainLockProvider>
      <Notes />
      <BrainLockControls />
    </BrainLockProvider>
  );
}

function vaultPage() {
  return render(
    <BrainLockProvider>
      <MemoryRouter>
        <Vault />
        <BrainLockControls />
      </MemoryRouter>
    </BrainLockProvider>
  );
}

describe("sensitive Notes access", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates with an accessible Sensitive information toggle that defaults off", async () => {
    let createBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/brain-lock/status")) {
          return jsonResponse({
            configured: true,
            unlocked: true,
            timeoutMinutes: 5,
            lockoutRemainingSeconds: 0,
          });
        }
        if (url.endsWith("/notes") && init?.method === "POST") {
          createBody = JSON.parse(String(init.body));
          return jsonResponse({ note: { ...note, sensitive: true } }, 201);
        }
        if (url.includes("/notes/captures")) return jsonResponse({ items: [] });
        if (url.includes("/notes/tags")) return jsonResponse({ items: [] });
        if (url.includes("/notes/config")) return jsonResponse({ dir: "C:/notes" });
        if (url.includes("/notes")) return jsonResponse({ items: [] });
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const user = userEvent.setup();
    notesPage();

    await user.click(await screen.findByRole("button", { name: "New Note" }));
    const toggle = screen.getByRole("checkbox", { name: "Sensitive information" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await user.type(screen.getByPlaceholderText("Title"), "Secret plan");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(createBody).toEqual(expect.objectContaining({ sensitive: true })));
  });

  it("omits sensitivity on an unchanged edit and sends it only after the toggle changes", async () => {
    const publicNote = { ...note, sensitive: false, title: "Public plan" };
    const updateBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/brain-lock/status")) {
          return jsonResponse({
            configured: true,
            unlocked: true,
            timeoutMinutes: 5,
            lockoutRemainingSeconds: 0,
          });
        }
        if (url.endsWith("/notes/note-1") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          updateBodies.push(body);
          return jsonResponse({ note: { ...publicNote, ...body } });
        }
        if (url.endsWith("/notes/note-1")) return jsonResponse({ note: publicNote });
        if (url.includes("/notes/captures")) return jsonResponse({ items: [] });
        if (url.includes("/notes/tags")) return jsonResponse({ items: [] });
        if (url.includes("/notes/config")) return jsonResponse({ dir: "C:/notes" });
        if (url.includes("/notes")) return jsonResponse({ items: [noteMeta(publicNote)] });
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const user = userEvent.setup();
    notesPage();

    await user.click(await screen.findByRole("button", { name: /Public plan/ }));
    const toggle = await screen.findByRole("checkbox", { name: "Sensitive information" });
    expect(toggle).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(updateBodies).toHaveLength(1));
    expect(updateBodies[0]).not.toHaveProperty("sensitive");

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(updateBodies).toHaveLength(2));
    expect(updateBodies[1]).toEqual(expect.objectContaining({ sensitive: true }));
  });

  it("closes a sensitive create while locked, reveals it after unlock, and removes it on lock", async () => {
    let unlocked = false;
    let stored = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/brain-lock/status")) {
          return jsonResponse({
            configured: true,
            unlocked,
            timeoutMinutes: 5,
            lockoutRemainingSeconds: 0,
          });
        }
        if (url.endsWith("/brain-lock/unlock")) {
          unlocked = true;
          return jsonResponse({
            configured: true,
            unlocked: true,
            timeoutMinutes: 5,
            lockoutRemainingSeconds: 0,
          });
        }
        if (url.endsWith("/brain-lock/lock")) {
          unlocked = false;
          return jsonResponse({ locked: true });
        }
        if (url.endsWith("/notes") && init?.method === "POST") {
          stored = true;
          return jsonResponse({ note: null }, 201);
        }
        if (url.includes("/notes/captures")) return jsonResponse({ items: [] });
        if (url.includes("/notes/tags")) return jsonResponse({ items: [] });
        if (url.includes("/notes/config")) return jsonResponse({ dir: "C:/notes" });
        if (url.includes("/notes")) {
          return jsonResponse({ items: unlocked && stored ? [noteMeta(note)] : [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const user = userEvent.setup();
    notesPage();

    await user.click(await screen.findByRole("button", { name: "New Note" }));
    await user.click(screen.getByRole("checkbox", { name: "Sensitive information" }));
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByText("Select a note, or start a new one.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Unlock sensitive notes" }));
    await user.type(screen.getByLabelText("Four-digit PIN"), "2468");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unlock sensitive notes",
      })
    );
    expect(await screen.findByRole("button", { name: /Secret plan/ })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Lock sensitive notes" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Secret plan/ })).not.toBeInTheDocument()
    );
  });

  it("removes protected Notes results after an inactivity lock", async () => {
    vi.useFakeTimers();
    let unlocked = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/brain-lock/status")) {
          return jsonResponse({
            configured: true,
            unlocked,
            timeoutMinutes: 1,
            lockoutRemainingSeconds: 0,
          });
        }
        if (url.endsWith("/brain-lock/lock")) {
          unlocked = false;
          return jsonResponse({ locked: true });
        }
        if (url.includes("/notes/captures")) return jsonResponse({ items: [] });
        if (url.includes("/notes/tags")) return jsonResponse({ items: [] });
        if (url.includes("/notes/config")) return jsonResponse({ dir: "C:/notes" });
        if (url.includes("/notes")) {
          return jsonResponse({ items: unlocked ? [noteMeta(note)] : [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    notesPage();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: /Secret plan/ })).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.queryByRole("button", { name: /Secret plan/ })).not.toBeInTheDocument();
  });

  it("discards an unlocked Notes response that settles after manual lock", async () => {
    let unlocked = true;
    let listRequests = 0;
    const staleList = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/brain-lock/status")) {
          return jsonResponse({
            configured: true,
            unlocked,
            timeoutMinutes: 5,
            lockoutRemainingSeconds: 0,
          });
        }
        if (url.endsWith("/brain-lock/lock")) {
          unlocked = false;
          return jsonResponse({ locked: true });
        }
        if (url.includes("/notes/captures")) return jsonResponse({ items: [] });
        if (url.includes("/notes/tags")) return jsonResponse({ items: [] });
        if (url.includes("/notes/config")) return jsonResponse({ dir: "C:/notes" });
        if (url.includes("/notes")) {
          listRequests += 1;
          return listRequests === 1 ? staleList.promise : jsonResponse({ items: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const user = userEvent.setup();
    notesPage();

    await user.click(await screen.findByRole("button", { name: "Lock sensitive notes" }));
    staleList.resolve(jsonResponse({ items: [noteMeta(note)] }));

    expect(await screen.findByText("No notes yet")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Secret plan/ })).not.toBeInTheDocument();
  });

  it("refetches and discards the Vault graph on unlock and manual lock", async () => {
    let unlocked = false;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/brain-lock/status")) {
          return jsonResponse({
            configured: true,
            unlocked,
            timeoutMinutes: 5,
            lockoutRemainingSeconds: 0,
          });
        }
        if (url.endsWith("/brain-lock/unlock")) {
          unlocked = true;
          return jsonResponse({
            configured: true,
            unlocked: true,
            timeoutMinutes: 5,
            lockoutRemainingSeconds: 0,
          });
        }
        if (url.endsWith("/brain-lock/lock")) {
          unlocked = false;
          return jsonResponse({ locked: true });
        }
        if (url.includes("/vault/graph")) {
          return jsonResponse({
            nodes: unlocked
              ? [
                  {
                    id: "note-1",
                    title: "Secret plan",
                    type: "note",
                    tags: [],
                    projectId: null,
                    updatedAt: "2026-08-12T12:00:00.000Z",
                  },
                ]
              : [],
            edges: [],
          });
        }
        if (url.includes("/vault/recall")) return jsonResponse({ items: [] });
        if (url.includes("/vault/engine/status")) {
          return jsonResponse({
            running: false,
            lastRun: null,
            totalEntities: 0,
            promotedEntities: 0,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const user = userEvent.setup();
    vaultPage();

    expect(await screen.findByText(/The vault is empty/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Unlock sensitive notes" }));
    await user.type(screen.getByLabelText("Four-digit PIN"), "2468");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unlock sensitive notes",
      })
    );
    expect(await screen.findByTitle("Hide Notes")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Lock sensitive notes" }));
    expect(await screen.findByText(/The vault is empty/)).toBeVisible();
  });

  it("discards an unlocked Vault response that settles after manual lock", async () => {
    let unlocked = true;
    let graphRequests = 0;
    const staleGraph = deferred<Response>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/brain-lock/status")) {
          return jsonResponse({
            configured: true,
            unlocked,
            timeoutMinutes: 5,
            lockoutRemainingSeconds: 0,
          });
        }
        if (url.endsWith("/brain-lock/lock")) {
          unlocked = false;
          return jsonResponse({ locked: true });
        }
        if (url.includes("/vault/graph")) {
          graphRequests += 1;
          return graphRequests === 1 ? staleGraph.promise : jsonResponse({ nodes: [], edges: [] });
        }
        if (url.includes("/vault/recall")) return jsonResponse({ items: [] });
        if (url.includes("/vault/engine/status")) {
          return jsonResponse({
            running: false,
            lastRun: null,
            totalEntities: 0,
            promotedEntities: 0,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const user = userEvent.setup();
    vaultPage();

    await user.click(await screen.findByRole("button", { name: "Lock sensitive notes" }));
    staleGraph.resolve(
      jsonResponse({
        nodes: [
          {
            id: "note-1",
            title: "Secret plan",
            type: "note",
            tags: [],
            projectId: null,
            updatedAt: "2026-08-12T12:00:00.000Z",
          },
        ],
        edges: [],
      })
    );

    expect(await screen.findByText(/The vault is empty/)).toBeVisible();
    expect(screen.queryByTitle("Hide Notes")).not.toBeInTheDocument();
  });
});
