/**
 * @file StatusBadge.tsx
 * @description Defines reusable React components for displaying the status of agents and sessions in a visually distinct way using badges. The AgentStatusBadge component shows the current status of an agent with an optional pulsing effect for active states, while the SessionStatusBadge component indicates the status of a session. Both components utilize predefined configurations for consistent styling across the application.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useTranslation } from "react-i18next";
import { STATUS_CONFIG, SESSION_STATUS_CONFIG } from "../lib/types";
import type { EffectiveAgentStatus, EffectiveSessionStatus } from "../lib/types";

interface AgentStatusBadgeProps {
  status: EffectiveAgentStatus;
  pulse?: boolean;
}

export function AgentStatusBadge({ status, pulse }: AgentStatusBadgeProps) {
  const { t } = useTranslation();
  const config = STATUS_CONFIG[status];
  // "waiting" pulses by default so the user's eye is drawn to sessions that
  // need their attention, matching the pulsing for active/working states.
  const shouldPulse = pulse ?? (status === "working" || status === "waiting");

  return (
    <span className={`badge ${config.bg} ${config.color}`}>
      <span
        className={`w-1.5 h-1.5 rounded-full ${config.dot} ${
          shouldPulse ? "animate-pulse-dot" : ""
        }`}
      />
      {t(config.labelKey)}
    </span>
  );
}

interface SessionStatusBadgeProps {
  status: EffectiveSessionStatus;
  pulse?: boolean;
}

export function SessionStatusBadge({ status, pulse }: SessionStatusBadgeProps) {
  const { t } = useTranslation();
  const config = SESSION_STATUS_CONFIG[status];
  const shouldPulse = pulse ?? status === "waiting";
  return (
    <span className={`badge ${config.bg} ${config.color}`}>
      {shouldPulse && (
        <span
          className={`w-1.5 h-1.5 rounded-full ${config.dot} animate-pulse-dot`}
          aria-hidden="true"
        />
      )}
      {t(config.labelKey)}
    </span>
  );
}

/**
 * Provider tag for a session row/card. Claude is the historical default and
 * stays unlabelled so existing sessions read exactly as before; only a
 * non-Claude provider (currently Codex) earns a badge.
 */
export function ProviderBadge({ provider }: { provider?: string }) {
  if (!provider || provider === "claude") return null;
  return (
    <span
      className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-sky-300 bg-sky-500/10 border border-sky-500/25 px-1.5 py-0.5 rounded-full"
      title={`${provider} session`}
    >
      {provider}
    </span>
  );
}
