/**
 * @file Browse.tsx
 * @description Live browser view (Phase Z, Tier 1). Ask Jarvis to search or open
 * a URL; a headless Chromium runs on the Mac (server host) and streams a
 * screenshot of every step here over the WebSocket (`browse_frame`) - so this
 * works from the phone, which is the whole point of "search X and show me".
 *
 * The browse itself is a gated assistant action: risk "confirm" by default (one
 * tap here), or "safe" if the user opted read-only navigation in inline via
 * Settings. We reuse the existing confirm round-trip (confirmToken).
 *
 * @author Jarvis (Phase Z1)
 */

import { useEffect, useRef, useState } from "react";
import { Globe, Send } from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import type { BrowseFramePayload, WSMessage } from "../lib/types";

type Frame = BrowseFramePayload;

export default function Browse() {
  const [input, setInput] = useState("");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [narration, setNarration] = useState<Frame[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // A confirm token pending a tap (risk "confirm"): the query that produced it.
  const pending = useRef<{ params: Record<string, unknown>; token: string } | null>(null);

  useEffect(() => {
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type !== "browse_frame") return;
      const f = msg.data as Frame;
      setFrame(f);
      setNarration((prev) => [...prev.slice(-19), f]);
    });
  }, []);

  // Hydrate the latest frame on mount: when Tabby deep-links here after a browse,
  // the WS frame already fired before this page existed, so fetch the last one.
  useEffect(() => {
    let live = true;
    api.assistant.browseLast().then(
      (res) => {
        if (live && res.frame) setFrame((cur) => cur ?? res.frame);
      },
      () => {}
    );
    return () => {
      live = false;
    };
  }, []);

  async function run(params: Record<string, unknown>, confirmToken?: string) {
    setBusy(true);
    setStatus(null);
    try {
      const out = await api.assistant.action({ name: "browse", params, confirmToken });
      if (out.pinRequired) {
        pending.current = null;
        setStatus("Unlock the Brain with your PIN to access that protected context.");
      } else if (out.status === "needs_confirm" && out.confirmToken) {
        pending.current = { params, token: out.confirmToken };
        setStatus("Browsing acts on the web in your name — tap Confirm to proceed.");
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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    // A bare URL opens directly; anything else is a search query.
    const params = /^https?:\/\/|^[\w-]+\.[a-z]{2,}(\/|$)/i.test(text)
      ? { url: text }
      : { query: text };
    setNarration([]);
    run(params);
  }

  function confirm() {
    if (pending.current) run(pending.current.params, pending.current.token);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1100 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Globe size={22} />
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Browse</h1>
          <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>
            Search or open a site — Jarvis drives a browser and streams it here live.
          </p>
        </div>
      </header>

      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search the web, or paste a URL…"
          aria-label="Search or URL"
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--hud-border, #334)",
            background: "var(--hud-panel, #0e1420)",
            color: "inherit",
            fontSize: 15,
          }}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px" }}
        >
          <Send size={16} /> {busy ? "Browsing…" : "Go"}
        </button>
      </form>

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
          <figcaption
            style={{
              display: "flex",
              gap: 8,
              alignItems: "baseline",
              fontSize: 13,
              opacity: 0.85,
              marginBottom: 6,
            }}
          >
            <strong style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {frame.title || "Untitled"}
            </strong>
            <span style={{ opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis" }}>
              {frame.url}
            </span>
          </figcaption>
          <img
            src={frame.image}
            alt={frame.title || "Browser view"}
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
          Nothing yet — enter a search or a URL above. The live view appears here (and on your
          phone).
        </p>
      )}

      {narration.length > 1 && (
        <ol style={{ opacity: 0.7, fontSize: 13, paddingLeft: 18, margin: 0 }}>
          {narration.map((f, i) => (
            <li key={`${f.at}-${i}`}>{f.note || f.url}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
