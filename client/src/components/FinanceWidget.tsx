/**
 * @file FinanceWidget.tsx
 * @description Compact subscriptions summary for the home command bridge
 * (Phase AE): per-currency monthly burn + the next renewal, linking to the
 * full /finance page. Self-hides while there are no active subscriptions -
 * same posture as GitHubWidget - so non-users see nothing. Live-updates on
 * the `subscriptions_updated` WebSocket event and degrades safely if that
 * event is delayed (it seeds from the summary endpoint on mount).
 */

import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Wallet, CalendarClock } from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import type { SubscriptionSummary, WSMessage } from "../lib/types";

const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", TRY: "₺" };
const fmtMoney = (amount: number, currency: string) =>
  `${SYMBOLS[currency] ?? `${currency} `}${amount.toFixed(2)}`;

export function FinanceWidget() {
  const [summary, setSummary] = useState<SubscriptionSummary | null>(null);

  const load = useCallback(() => {
    const p = api.subscriptions?.summary?.();
    if (!p) {
      setSummary(null);
      return;
    }
    p.then(setSummary).catch(() => setSummary(null));
  }, []);

  useEffect(() => {
    load();
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "subscriptions_updated") load();
    });
  }, [load]);

  // Hidden until something is tracked - no clutter for non-users.
  if (!summary || summary.active_count === 0) return null;

  const burn = Object.entries(summary.by_currency)
    .map(([cur, v]) => fmtMoney(v.monthly_burn, cur))
    .join(" + ");
  const next = summary.next_renewal;

  return (
    <NavLink
      to="/finance"
      className="holo-panel hud-frame holo-boot flex items-center gap-3 p-3 hover:border-accent/40 transition-colors"
      style={{ "--boot-delay": "0.66s" } as React.CSSProperties}
    >
      <Wallet className="w-4 h-4 flex-shrink-0 text-accent/80" />
      <span className="hud-label">Finance</span>
      <span className="text-xs font-medium text-gray-300">
        {burn}
        <span className="text-gray-500">/mo</span>
      </span>
      {next && (
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-400 min-w-0">
          <CalendarClock className="w-3.5 h-3.5 flex-shrink-0 text-accent/60" />
          <span className="truncate">
            {next.name} {fmtMoney(next.amount, next.currency)}{" "}
            {next.days_until === 0
              ? "today"
              : next.days_until === 1
                ? "tomorrow"
                : `in ${next.days_until}d`}
          </span>
        </span>
      )}
    </NavLink>
  );
}
