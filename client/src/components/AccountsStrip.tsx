/**
 * @file AccountsStrip.tsx
 * @description Compact multi-account (claude-swap) indicator shown under the
 * JarvisCore (Phase K). Renders the active account with a badge plus a small
 * secondary line for the other account(s) and their reset time when known
 * ("Acct 2 resets 3:40pm"). Self-hides entirely when claude-swap isn't detected
 * (`present === false`), so single-account setups see nothing - zero regression.
 *
 * Read-only: the dashboard observes claude-swap, it never triggers a swap.
 * Live-updates on the `account_swapped` WebSocket event.
 */

import { useCallback, useEffect, useState } from "react";
import { Users, ArrowLeftRight } from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import type { AccountsState, Account, WSMessage } from "../lib/types";
import { formatTime } from "../lib/format";

function accountLabel(a: Account): string {
  return a.label || a.id;
}

export function AccountsStrip() {
  const [state, setState] = useState<AccountsState | null>(null);

  const load = useCallback(() => {
    // Guard the whole call: on an older server build (or a test harness without
    // the endpoint) `api.accounts` may be absent - stay hidden rather than throw.
    const p = api.accounts?.get?.();
    if (!p) {
      setState(null);
      return;
    }
    p.then(setState).catch(() => setState(null));
  }, []);

  useEffect(() => {
    load();
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "account_swapped") load();
    });
  }, [load]);

  if (!state || !state.present || state.accounts.length === 0) return null;

  const active = state.accounts.find((a) => a.active) || null;
  const others = state.accounts.filter((a) => !a.active);

  return (
    <div className="mt-3 mx-auto max-w-[26rem] rounded-xl border border-border bg-surface-2/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <Users className="w-3.5 h-3.5 text-accent flex-shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          Accounts
        </span>
        {active && (
          <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium text-accent bg-accent/10 border border-accent/25">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            {accountLabel(active)}
          </span>
        )}
      </div>

      {others.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {others.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-1.5 text-[11px] text-gray-500 font-mono"
            >
              <ArrowLeftRight className="w-3 h-3 flex-shrink-0 text-gray-600" />
              <span className="truncate">{accountLabel(a)}</span>
              {a.resets_at && (
                <span className="ml-auto text-gray-600">resets {formatTime(a.resets_at)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
