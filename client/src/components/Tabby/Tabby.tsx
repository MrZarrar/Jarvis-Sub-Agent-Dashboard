/**
 * @file Tabby.tsx
 * @description Floating Mini-JARVIS companion shell. Mounts once (next to UpdateNotifier
 *   in Layout) so it persists across routes and shares the single WebSocket.
 *   Owns the open/closed panel state, the ⌘B / Esc shortcuts, reduced-motion
 *   detection, and route navigation. Reactive personality + status/Ask come
 *   from useTabbyBrain; the avatar is draggable (AssistiveTouch-style) via
 *   useTabbyPosition, and the bubble/panel render in a self-clamping flyout so
 *   they never spill off any screen edge regardless of where the orb is docked
 *   (on mobile the panel is a bottom sheet instead - Phase M2).
 *
 *   Ask queries go to the assistant brain via TabbyPanel (Phase M2): it answers
 *   in-popup and can execute actions. Client-side actions (set_hud_mode /
 *   navigate) run here through onClientAction. The old auto-deep-link to
 *   /run?prompt=… is gone - handoff is now an explicit "Run as agent" affordance.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { JarvisAvatar } from "./JarvisAvatar";
import { SpeechBubble } from "./SpeechBubble";
import { TabbyPanel } from "./TabbyPanel";
import { useTabbyBrain } from "./useTabbyBrain";
import { useTabbyPosition, TABBY_SIZE } from "./useTabbyPosition";
import { tabbyPrefs } from "./prefs";
import { useIsMobile } from "../../hooks/useIsMobile";
import { hudMode, type HudModeSetting } from "../../lib/hudMode";
import "./tabby.css";

const FLYOUT_GAP = 10; // px between avatar and flyout
const VIEWPORT_MARGIN = 12; // min gap from any screen edge
const DRAG_HANDLE_SELECTOR = "[data-tabby-drag-handle]";
const INTERACTIVE_SELECTOR = "button, select, input, a, [role='button']";
const PANEL_DRAG_THRESHOLD = 4;

interface Anchor {
  left: number;
  top: number;
  size: number;
  side: "left" | "right";
  openUp: boolean;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/**
 * Fixed-position wrapper that places its content next to the avatar and clamps
 * it inside the viewport. It measures itself (and re-measures on content/size
 * changes via ResizeObserver) so a tall panel near a screen edge slides fully
 * into view instead of being cropped.
 *
 * When `draggable`, a manual drag offset (persisted via tabbyPrefs) applies on
 * top of the natural anchored position - grabbing anywhere with a
 * `[data-tabby-drag-handle]` ancestor (the panel header) moves the whole flyout
 * and it stays put on close/reopen; double-clicking the handle resets it.
 */
function TabbyFlyout({
  anchor,
  children,
  draggable = false,
}: {
  anchor: Anchor;
  children: ReactNode;
  draggable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const naturalRef = useRef({ left: 0, top: 0 });
  const offsetRef = useRef(
    draggable ? (tabbyPrefs.getPanelOffset() ?? { dx: 0, dy: 0 }) : { dx: 0, dy: 0 }
  );
  const [dragPos, setDragPos] = useState<{ left: number; top: number } | null>(null);
  const draggingRef = useRef(false);
  const dragStart = useRef<{ px: number; py: number; left: number; top: number } | null>(null);

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: hug the avatar's docked edge, then clamp on-screen.
    let left = anchor.side === "left" ? anchor.left : anchor.left + anchor.size - w;
    left = Math.min(vw - w - VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, left));

    // Vertical: prefer above the orb (feels natural). Only drop below when
    // there isn't room above - i.e. the orb is near the top edge.
    const above = anchor.top - h - FLYOUT_GAP;
    const below = anchor.top + anchor.size + FLYOUT_GAP;
    let top = above >= VIEWPORT_MARGIN ? above : below;
    top = Math.min(vh - h - VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, top));

    naturalRef.current = { left, top };
    if (draggingRef.current) return; // the pointer handlers own `style` mid-drag

    const { dx, dy } = offsetRef.current;
    const finalLeft = Math.min(vw - w - VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, left + dx));
    const finalTop = Math.min(vh - h - VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, top + dy));
    setStyle({ left: finalLeft, top: finalTop, visibility: "visible" });
  }, [anchor.left, anchor.top, anchor.size, anchor.side, anchor.openUp]);

  useLayoutEffect(() => {
    place();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [place]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggable) return;
      const target = e.target as HTMLElement;
      if (!target.closest?.(DRAG_HANDLE_SELECTOR)) return;
      // The whole header is the drag zone, but real controls inside it
      // (provider select, expand/close buttons) must still work normally.
      if (target.closest?.(INTERACTIVE_SELECTOR)) return;
      try {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* capture unsupported - window-free fallback still works via props */
      }
      const curLeft = typeof style.left === "number" ? style.left : naturalRef.current.left;
      const curTop = typeof style.top === "number" ? style.top : naturalRef.current.top;
      dragStart.current = { px: e.clientX, py: e.clientY, left: curLeft, top: curTop };
    },
    [draggable, style.left, style.top]
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    const el = ref.current;
    if (!start || !el) return;
    const dx = e.clientX - start.px;
    const dy = e.clientY - start.py;
    if (!draggingRef.current && Math.hypot(dx, dy) < PANEL_DRAG_THRESHOLD) return;
    draggingRef.current = true;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(vw - w - VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, start.left + dx));
    const top = Math.min(vh - h - VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, start.top + dy));
    setDragPos({ left, top });
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    try {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    dragStart.current = null;
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragPos((pos) => {
      if (pos) {
        const next = {
          dx: pos.left - naturalRef.current.left,
          dy: pos.top - naturalRef.current.top,
        };
        offsetRef.current = next;
        tabbyPrefs.setPanelOffset(next);
        // Commit the drop position into `style` immediately - without this the
        // panel would render from the stale pre-drag `style` for one frame
        // once `dragPos` clears below, snapping back before the next natural
        // recompute (which may not happen for a while). It should stay
        // exactly where it was let go.
        setStyle({ left: pos.left, top: pos.top, visibility: "visible" });
      }
      return null;
    });
  }, []);

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!draggable) return;
      const target = e.target as HTMLElement;
      if (!target.closest?.(DRAG_HANDLE_SELECTOR)) return;
      if (target.closest?.(INTERACTIVE_SELECTOR)) return;
      offsetRef.current = { dx: 0, dy: 0 };
      tabbyPrefs.setPanelOffset(null);
      setDragPos(null);
      place();
    },
    [draggable, place]
  );

  return (
    <div
      ref={ref}
      className="tabby-flyout"
      style={dragPos ? { left: dragPos.left, top: dragPos.top, visibility: "visible" } : style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {children}
    </div>
  );
}

export function Tabby() {
  const [enabled, setEnabled] = useState(() => tabbyPrefs.getEnabled());
  const [open, setOpen] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const navigate = useNavigate();
  const brain = useTabbyBrain();
  const place = useTabbyPosition();
  const isMobile = useIsMobile();

  // Keep enabled in sync with Settings / other tabs.
  useEffect(() => tabbyPrefs.subscribe(() => setEnabled(tabbyPrefs.getEnabled())), []);

  // ⌘B / Ctrl+B toggles the panel; Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onNavigate = useCallback(
    (route: string) => {
      navigate(route);
      setOpen(false);
    },
    [navigate]
  );

  // Execute a client-side assistant action returned by the ask/action response
  // (§3.1 side:"client"). This is what makes "enable ultron" flip the HUD in
  // place instead of just describing it.
  const onClientAction = useCallback(
    (name: string, params: Record<string, unknown>) => {
      if (name === "set_hud_mode") {
        const mode = params.mode;
        if (mode === "jarvis" || mode === "ultron" || mode === "auto") {
          hudMode.setSetting(mode as HudModeSetting);
        }
      } else if (name === "navigate" && typeof params.to === "string") {
        navigate(params.to);
        setOpen(false);
      }
      // open_panel: no separate popup panels yet (inbox lands in Phase O); the
      // popup is already open, so this is a no-op for now.
    },
    [navigate]
  );

  if (!enabled) return null;

  const anchor: Anchor = {
    left: place.left,
    top: place.top,
    size: place.size,
    side: place.side,
    openUp: place.openUp,
  };

  const panel = (
    <TabbyPanel
      status={brain.status}
      muted={brain.muted}
      onToggleMute={brain.toggleMute}
      asleep={brain.asleep}
      onToggleSleep={brain.toggleSleep}
      onClearAlerts={brain.clearAlerts}
      onNavigate={onNavigate}
      onClientAction={onClientAction}
      onThinking={brain.setThinking}
      onClose={() => setOpen(false)}
      layout={isMobile ? "sheet" : "flyout"}
    />
  );

  return (
    <>
      {/* On mobile the popup is a bottom sheet (Phase M2 step 8): full-width,
          docked above the tab bar, with a tap-to-dismiss backdrop. */}
      {open && isMobile && (
        <>
          <div className="tabby-sheet-backdrop" onClick={() => setOpen(false)} />
          <div className="tabby-sheet">{panel}</div>
        </>
      )}

      {/* Flyouts are hidden while dragging so they don't chase the orb. */}
      {!place.dragging && open && !isMobile && (
        <TabbyFlyout anchor={anchor} draggable>
          {panel}
        </TabbyFlyout>
      )}

      {!place.dragging && !open && brain.bubble && (
        <TabbyFlyout anchor={anchor}>
          <SpeechBubble text={brain.bubble} onDismiss={brain.dismissBubble} />
        </TabbyFlyout>
      )}

      <button
        className="tabby-avatar-btn"
        data-dragging={place.dragging ? "1" : "0"}
        style={{ left: place.left, top: place.top, width: TABBY_SIZE, height: TABBY_SIZE }}
        onPointerDown={place.onPointerDown}
        onPointerMove={place.onPointerMove}
        onPointerUp={place.onPointerUp}
        onClick={() => {
          // A drag just ended - swallow the synthetic click so the panel
          // doesn't toggle when the user only repositioned the avatar.
          if (place.consumeDrag()) return;
          setOpen((v) => !v);
        }}
        aria-label={open ? "Close JARVIS companion" : "Open JARVIS companion"}
        aria-expanded={open}
        title="Mini JARVIS - ⌘B · drag to move"
      >
        <JarvisAvatar mood={brain.mood} reducedMotion={reducedMotion} />
        {brain.status.errorCount > 0 && (
          <span className="tabby-error-dot" aria-hidden>
            {brain.status.errorCount > 9 ? "9+" : brain.status.errorCount}
          </span>
        )}
      </button>
    </>
  );
}
