/**
 * @file useVerbosity.ts
 * @description Phase AF feed-verbosity setting. "agent" (default) collapses
 * per-tool envelopes on ambient surfaces (home Operations feed, ActivityFeed)
 * behind expandable agent rows and hides the noisier home instruments;
 * "tool" restores the full firehose. Persisted server-side in app_settings so
 * every device sees the same view. Debugging surfaces (Run/SessionDetail)
 * ignore this on purpose.
 */

import { useEffect, useState } from "react";
import { api } from "../lib/api";

export type Verbosity = "agent" | "tool";

// Module-level cache so a surface mounting after the first GET doesn't flash
// the default while its own fetch is in flight.
let cached: Verbosity | null = null;

export function useVerbosity(): [Verbosity, (level: Verbosity) => void] {
  const [level, setLevel] = useState<Verbosity>(cached ?? "agent");

  useEffect(() => {
    if (cached) return;
    api.settings.verbosity
      .get()
      .then((res) => {
        cached = res.level === "tool" ? "tool" : "agent";
        setLevel(cached);
      })
      .catch(() => {
        // Non-fatal: stay on the quiet default.
      });
  }, []);

  const update = (next: Verbosity) => {
    cached = next;
    setLevel(next);
    api.settings.verbosity.set(next).catch(() => {
      // Best-effort persistence; the in-memory toggle already applied.
    });
  };

  return [level, update];
}
