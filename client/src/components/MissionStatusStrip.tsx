import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Orbit, Timer } from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { formatDateTime, truncate } from "../lib/format";
import type { Mission, ProviderCapabilities, ScheduledPrompt, WSMessage } from "../lib/types";

const LIVE = new Set(["queued", "planning", "delegated", "running"]);

export function MissionStatusStrip({ expanded = false }: { expanded?: boolean }) {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [next, setNext] = useState<ScheduledPrompt | null>(null);
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(null);

  const load = useCallback(async () => {
    try {
      const [missionResult, scheduleResult, providerResult] = await Promise.all([
        api.missions.list(),
        api.schedules.list("pending"),
        api.providers.capabilities(),
      ]);
      setMissions(missionResult.items);
      setNext(
        [...scheduleResult.items]
          .filter((item) => item.fire_at)
          .sort((a, b) => Date.parse(a.fire_at || "") - Date.parse(b.fire_at || ""))[0] || null
      );
      setCapabilities(providerResult);
    } catch {
      setCapabilities(null);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    const unsubscribe = eventBus.subscribe((message: WSMessage) => {
      if (message.type.startsWith("mission.") || message.type.startsWith("schedule_")) load();
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [load]);

  const state = useMemo(() => {
    const running = missions.filter((mission) => LIVE.has(mission.status));
    const needs = missions.filter(
      (mission) => mission.status === "waiting_approval" || mission.status === "blocked"
    );
    const finished =
      missions.find((mission) => mission.status === "completed" || mission.status === "failed") ||
      null;
    const healthy =
      capabilities?.providers.some((provider) => provider.id === "codex" && provider.available) ||
      false;
    return { running, needs, finished, healthy };
  }, [missions, capabilities]);

  return (
    <section className="card p-4" aria-label="Mission command status">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Status
          label="Running"
          value={String(state.running.length)}
          icon={<Orbit className="w-4 h-4 text-cyan-300" />}
        />
        <Status
          label="Needs you"
          value={String(state.needs.length)}
          icon={
            <AlertTriangle
              className={`w-4 h-4 ${state.needs.length ? "text-amber-300" : "text-gray-600"}`}
            />
          }
        />
        <Status
          label="Latest"
          value={state.finished ? truncate(state.finished.title, 28) : "None yet"}
          icon={<CheckCircle2 className="w-4 h-4 text-emerald-300" />}
        />
        <Status
          label="Next"
          value={next?.fire_at ? formatDateTime(next.fire_at) : "Nothing queued"}
          icon={<Timer className="w-4 h-4 text-violet-300" />}
        />
        <Link
          to="/missions"
          className="col-span-2 lg:col-span-1 rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 hover:bg-cyan-500/15"
        >
          <p className="text-[10px] uppercase tracking-wide text-cyan-400">System</p>
          <p className={`mt-1 text-xs ${state.healthy ? "text-emerald-300" : "text-amber-300"}`}>
            {state.healthy ? "Codex kernel ready" : "Check provider health"}
          </p>
        </Link>
      </div>
      {expanded && state.running.length > 0 && (
        <div className="mt-3 border-t border-border pt-3 grid gap-2 sm:grid-cols-2">
          {state.running.slice(0, 4).map((mission) => (
            <Link
              key={mission.id}
              to={`/missions/${encodeURIComponent(mission.id)}`}
              className="rounded-lg bg-surface-2 px-3 py-2 hover:bg-surface-3"
            >
              <p className="text-xs text-gray-200 truncate">{mission.title}</p>
              <p className="mt-1 text-[10px] text-gray-500 capitalize">
                {mission.domain} · {mission.owner_provider}
                {mission.worker_provider ? ` → ${mission.worker_provider}` : ""} ·{" "}
                {mission.status.replace(/_/g, " ")}
              </p>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function Status({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <span>{icon}</span>
        <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
      </div>
      <p className="mt-1 text-xs text-gray-200 truncate">{value}</p>
    </div>
  );
}
