/**
 * @file ComputerUse.tsx
 * @description Live desktop view (Phase Z, Tier 2). Unlike `/browse` (a headless,
 * read-only Chromium view), this shows the REAL Mac screen: `screencapture` +
 * macOS "System Events" UI scripting drive actual clicks/keystrokes, streamed
 * here over the WebSocket (`computer_use_frame`) so it works from the phone too.
 *
 * There's no URL bar here - you need to see the screen before deciding where to
 * click, so the only manual trigger is "take a screenshot"; clicking/typing is
 * driven by Jarvis (via the gated `computer_use` action, e.g. from the Tabby
 * popup). Same confirm round-trip as Browse.tsx (risk "confirm" by default, or
 * "safe" if opted in at Settings → Assistant Access).
 *
 * @author Jarvis (Phase Z2)
 */

import { useEffect, useRef, useState } from "react";
import { MousePointerClick, Camera } from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import type { ComputerUseFramePayload, WSMessage } from "../lib/types";

type Frame = ComputerUseFramePayload;

export default function ComputerUse() {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [narration, setNarration] = useState<Frame[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // A confirm token pending a tap (risk "confirm").
  const pending = useRef<{ token: string } | null>(null);

  useEffect(() => {
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type !== "computer_use_frame") return;
      const f = msg.data as Frame;
      setFrame(f);
      setNarration((prev) => [...prev.slice(-19), f]);
    });
  }, []);

  // Hydrate the latest frame on mount, same reasoning as Browse.tsx: a frame
  // may already have streamed before this page existed.
  useEffect(() => {
    let live = true;
    api.assistant.computerUseLast().then(
      (res) => {
        if (live && res.frame) setFrame((cur) => cur ?? res.frame);
      },
      () => {}
    );
    return () => {
      live = false;
    };
  }, []);

  async function run(confirmToken?: string) {
    setBusy(true);
    setStatus(null);
    try {
      const out = await api.assistant.action({ name: "computer_use", params: {}, confirmToken });
      if (out.status === "needs_confirm" && out.confirmToken) {
        pending.current = { token: out.confirmToken };
        setStatus("This controls your real Mac desktop — tap Confirm to proceed.");
      } else if (out.status === "done") {
        pending.current = null;
      } else if (out.status === "denied") {
        setStatus(out.reason || "Denied.");
      } else if (out.status === "error") {
        setStatus(out.error || "Something went wrong.");
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  function confirm() {
    if (pending.current) run(pending.current.token);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1100 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <MousePointerClick size={22} />
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Computer Use</h1>
          <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>
            The real Mac screen — Jarvis clicks and types here directly (macOS only).
          </p>
        </div>
      </header>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => run()}
          disabled={busy}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px" }}
        >
          <Camera size={16} /> {busy ? "Working…" : "Take a screenshot"}
        </button>
      </div>

      {status && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--hud-accent, #c94)",
            fontSize: 14,
          }}
        >
          <span style={{ flex: 1 }}>{status}</span>
          {pending.current && (
            <button type="button" onClick={confirm} disabled={busy}>
              Confirm
            </button>
          )}
        </div>
      )}

      {frame ? (
        <figure style={{ margin: 0 }}>
          <figcaption style={{ fontSize: 13, opacity: 0.85, marginBottom: 6 }}>
            {frame.note || "Screenshot"} · {new Date(frame.at).toLocaleTimeString()}
          </figcaption>
          <img
            src={frame.image}
            alt={frame.note || "Desktop view"}
            style={{
              width: "100%",
              maxWidth: "100%",
              borderRadius: 8,
              border: "1px solid var(--hud-border, #334)",
              display: "block",
            }}
          />
        </figure>
      ) : (
        <p style={{ opacity: 0.6, fontSize: 14 }}>
          Nothing yet — take a screenshot, or ask Jarvis to do something on your screen. The live
          view appears here (and on your phone).
        </p>
      )}

      {narration.length > 1 && (
        <ol style={{ opacity: 0.7, fontSize: 13, paddingLeft: 18, margin: 0 }}>
          {narration.map((f, i) => (
            <li key={`${f.at}-${i}`}>{f.note || "step"}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
