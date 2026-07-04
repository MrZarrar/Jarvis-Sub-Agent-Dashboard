/**
 * @file prefs.ts
 * @description Tiny localStorage-backed preference store for Tabby (enabled +
 *   muted). Broadcasts changes via a window CustomEvent so the Settings toggle
 *   and the live widget stay in sync within the same tab without a reload.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const ENABLED_KEY = "agent-dashboard-tabby-enabled";
const MUTED_KEY = "agent-dashboard-tabby-muted";
const SLEEP_KEY = "agent-dashboard-tabby-sleep";
const POS_KEY = "agent-dashboard-tabby-pos";
const EXPANDED_KEY = "agent-dashboard-tabby-expanded";
const PROVIDER_KEY = "agent-dashboard-tabby-provider";
const PANEL_OFFSET_KEY = "agent-dashboard-tabby-panel-offset";
const CONVO_KEY = "agent-dashboard-tabby-convo";
const EVENT = "tabby:prefs";

/** Manual drag offset (px) applied on top of the panel's natural anchored
 *  position, so it can be dragged away from the avatar and stay put. */
export interface PanelOffset {
  dx: number;
  dy: number;
}

/**
 * Persisted resting position, AssistiveTouch-style: the widget always docks to
 * the left or right edge, remembering its vertical offset. `y` is stored as a
 * fraction of the viewport height (0–1) so it survives window resizes.
 */
export interface TabbyPos {
  side: "left" | "right";
  y: number;
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "true";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Ignore storage failures (private mode, quota) - prefs are best-effort.
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    // SSR / non-DOM contexts: nothing to notify.
  }
}

function readPos(): TabbyPos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<TabbyPos>;
    if ((p.side === "left" || p.side === "right") && typeof p.y === "number") {
      return { side: p.side, y: Math.min(1, Math.max(0, p.y)) };
    }
    return null;
  } catch {
    return null;
  }
}

function writePos(pos: TabbyPos): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    // Ignore storage failures - position is best-effort.
  }
  // Note: intentionally does NOT dispatch the prefs event - position changes
  // are local to the widget and shouldn't churn the Settings toggle listeners.
}

function readPanelOffset(): PanelOffset | null {
  try {
    const raw = localStorage.getItem(PANEL_OFFSET_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<PanelOffset>;
    if (typeof o.dx === "number" && typeof o.dy === "number") return { dx: o.dx, dy: o.dy };
    return null;
  } catch {
    return null;
  }
}

function writePanelOffset(offset: PanelOffset | null): void {
  try {
    if (offset) localStorage.setItem(PANEL_OFFSET_KEY, JSON.stringify(offset));
    else localStorage.removeItem(PANEL_OFFSET_KEY);
  } catch {
    // Ignore storage failures - offset is best-effort.
  }
}

export const tabbyPrefs = {
  getEnabled: () => readBool(ENABLED_KEY, false),
  setEnabled: (v: boolean) => writeBool(ENABLED_KEY, v),
  getMuted: () => readBool(MUTED_KEY, false),
  setMuted: (v: boolean) => writeBool(MUTED_KEY, v),
  /** Manual "put it back to sleep" override - persisted, so it stays asleep
   *  across reloads until you wake it (or a real error breaks through). */
  getManualSleep: () => readBool(SLEEP_KEY, false),
  setManualSleep: (v: boolean) => writeBool(SLEEP_KEY, v),
  /** Popup size: compact (false) vs expanded (true). Persisted, no event churn. */
  getExpanded: () => readBool(EXPANDED_KEY, false),
  setExpanded: (v: boolean) => writeBool(EXPANDED_KEY, v),
  /** Sticky provider pick for the popup ("" = default). Mirrors the spoken pref. */
  getProvider(): string {
    try {
      return localStorage.getItem(PROVIDER_KEY) || "";
    } catch {
      return "";
    }
  },
  setProvider(v: string): void {
    try {
      if (v) localStorage.setItem(PROVIDER_KEY, v);
      else localStorage.removeItem(PROVIDER_KEY);
    } catch {
      /* best-effort */
    }
  },
  getPos: readPos,
  setPos: writePos,
  /** Manual drag offset for the popup, on top of its natural anchored position. */
  getPanelOffset: readPanelOffset,
  setPanelOffset: writePanelOffset,
  /** Raw conversation transcript persistence - the shape is owned by TabbyPanel;
   *  this is just a JSON blob store so closing/reopening the popup (or a page
   *  reload) doesn't wipe the conversation. Cleared explicitly by "Clear chat". */
  getConversation(): unknown | null {
    try {
      const raw = localStorage.getItem(CONVO_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  setConversation(data: unknown): void {
    try {
      localStorage.setItem(CONVO_KEY, JSON.stringify(data));
    } catch {
      /* best-effort - a full/private-mode localStorage just won't persist it */
    }
  },
  clearConversation(): void {
    try {
      localStorage.removeItem(CONVO_KEY);
    } catch {
      /* ignore */
    }
  },
  /** Subscribe to any pref change; returns an unsubscribe fn. */
  subscribe(handler: () => void): () => void {
    const listener = () => handler();
    window.addEventListener(EVENT, listener);
    // Also react to changes from other tabs.
    window.addEventListener("storage", listener);
    return () => {
      window.removeEventListener(EVENT, listener);
      window.removeEventListener("storage", listener);
    };
  },
};
