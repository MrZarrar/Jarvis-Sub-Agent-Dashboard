/**
 * @file PermissionRequests.tsx
 * @description Renders pending interactive-permission requests for a Run page
 * session (Phase 3 of the interactive-permissions plan). One card per pending
 * tool call with Allow/Deny buttons, wired to
 * `POST /api/run/:id/permission/request/:requestId`. The server-side gate
 * (scripts/permission-gate.js) blocks the tool call until this resolves or
 * its own TTL expires it as a deny.
 *
 * Only pending requests are shown - once resolved (locally or by another
 * client), the request disappears from the list on the next
 * permission_resolved broadcast or poll.
 */

import { ShieldQuestion, Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PermissionDecision, PermissionEntry } from "../lib/types";
import { ToolCallBlock } from "./conversation/ToolCallBlock";
import type { TranscriptContent } from "../lib/types";

interface PermissionRequestsProps {
  items: PermissionEntry[];
  /** requestId currently being resolved (disables its buttons), if any. */
  busyId?: string | null;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
}

export function PermissionRequests({ items, busyId, onDecide }: PermissionRequestsProps) {
  const { t } = useTranslation("run");
  const pending = items
    .filter((i) => i.status === "pending")
    .sort((a, b) => a.openedAt - b.openedAt);
  if (pending.length === 0) return null;

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 space-y-2.5">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-amber-300">
        <ShieldQuestion className="w-3.5 h-3.5" />
        {t("permissions.panelTitle", "Permission requests")}
        <span className="text-amber-400/70 font-mono">{pending.length}</span>
      </div>
      {pending.map((req) => {
        const toolUse: TranscriptContent = {
          type: "tool_use",
          id: req.requestId,
          name: req.toolName,
          input: (req.toolInput ?? undefined) as TranscriptContent["input"],
        };
        const busy = busyId === req.requestId;
        return (
          <div
            key={req.requestId}
            id={`permission-${req.requestId}`}
            className="rounded-lg border border-amber-500/30 bg-surface-1/80 p-2.5 space-y-2 scroll-mt-24"
          >
            <ToolCallBlock toolUse={toolUse} />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => onDecide(req.requestId, "deny")}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 hover:bg-red-500/20 text-red-200 px-2.5 py-1 text-[11px] font-medium disabled:opacity-50 transition-colors"
              >
                <X className="w-3 h-3" />
                {t("permissions.deny", "Deny")}
              </button>
              <button
                onClick={() => onDecide(req.requestId, "allow")}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 px-2.5 py-1 text-[11px] font-medium disabled:opacity-50 transition-colors"
              >
                <Check className="w-3 h-3" />
                {t("permissions.allow", "Allow")}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
