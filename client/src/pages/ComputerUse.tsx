/**
 * @file ComputerUse.tsx
 * @description Low-overhead Mac snapshot view. Native `screencapture` frames
 * stream over the existing `computer_use_frame` WebSocket so the phone can
 * monitor the real desktop without keeping a live video session running.
 *
 * @author Jarvis (Phase Z2)
 */

import { useCallback, useEffect, useState } from "react";
import { Camera, Pause, Play } from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import type { ComputerUseFramePayload, WSMessage } from "../lib/types";

type Frame = ComputerUseFramePayload;
const SNAPSHOT_INTERVAL_MS = 1_000;

export default function ComputerUse() {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [narration, setNarration] = useState<Frame[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [live, setLive] = useState(
    () => new URLSearchParams(window.location.search).get("live") === "1"
  );

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

  const capture = useCallback(async () => {
    setBusy(true);
    try {
      await api.assistant.computerUseSnapshot();
      setStatus(null);
      return true;
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      const ok = document.visibilityState !== "visible" || (await capture());
      if (stopped) return;
      if (!ok) return setLive(false);
      timer = window.setTimeout(tick, SNAPSHOT_INTERVAL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [capture, live]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1100 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Camera size={22} />
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Mac Snapshots</h1>
          <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>
            A fresh Mac screenshot every second while this page is visible.
          </p>
        </div>
      </header>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => setLive((value) => !value)}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px" }}
        >
          {live ? <Pause size={16} /> : <Play size={16} />}
          {live ? "Stop snapshots" : "Start snapshots"}
        </button>
        <button
          type="button"
          onClick={() => void capture()}
          disabled={busy}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px" }}
        >
          <Camera size={16} /> {busy ? "Capturing…" : "Refresh now"}
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
          Nothing yet — start snapshots or refresh once. macOS may ask you to grant Screen Recording
          permission to the dashboard process.
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
