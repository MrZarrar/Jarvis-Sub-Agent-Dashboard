/**
 * @file AgentRoom.tsx
 * @description The Ops Room - an animated overhead view of every active agent
 * as a little character at a desk, cast by what it's doing right now
 * (agent.current_tool, live from the hooks pipeline):
 *   - recon (Grep/Glob/WebSearch/WebFetch)  → the sleuth 🕵️
 *   - writing code (Edit/Write/NotebookEdit) → the code monkey 🐵
 *   - running commands (Bash)                → the robot 🤖
 *   - reading (Read)                         → the scholar 📖
 *   - delegating (Task/Agent)                → the commander 🧠
 *   - planning (TodoWrite/ExitPlanMode)      → the strategist 📋
 *   - waiting on the user                    → asleep at the desk 💤
 * Purely presentational: takes the agent list the parent already polls, no
 * fetching of its own. Used as a Dashboard Operations tab and a Wall panel
 * (size="wall" scales the sprites up for across-the-room reading).
 */

import { useNavigate } from "react-router-dom";
import type { Agent, Session } from "../lib/types";

interface Casting {
  emoji: string;
  role: string;
  tone: string; // accent color for the desk glow / status ring
}

function castAgent(agent: Agent): Casting {
  if (agent.status === "waiting") return { emoji: "💤", role: "waiting on you", tone: "#fbbf24" };
  const tool = (agent.current_tool || "").toLowerCase();
  if (/grep|glob|websearch|webfetch|search/.test(tool))
    return { emoji: "🕵️", role: "sleuthing", tone: "#60a5fa" };
  if (/edit|write|notebook/.test(tool))
    return { emoji: "🐵", role: "typing code", tone: "#34d399" };
  if (/bash|command|shell/.test(tool))
    return { emoji: "🤖", role: "running commands", tone: "#f472b6" };
  if (/^read/.test(tool)) return { emoji: "📖", role: "reading", tone: "#a78bfa" };
  if (/task|agent/.test(tool)) return { emoji: "🧠", role: "delegating", tone: "#22d3ee" };
  if (/todo|plan/.test(tool)) return { emoji: "📋", role: "planning", tone: "#fbbf24" };
  return { emoji: "⚙️", role: "working", tone: "#34d399" };
}

function Desk({
  agent,
  casting,
  label,
  size,
  index,
  onClick,
}: {
  agent: Agent;
  casting: Casting;
  label: string;
  size: "panel" | "wall";
  index: number;
  onClick?: () => void;
}) {
  const wall = size === "wall";
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1.5 p-3 rounded-2xl transition-transform hover:scale-105 focus:outline-none"
      style={{ cursor: onClick ? "pointer" : "default" }}
      title={`${agent.name} · ${casting.role}${agent.current_tool ? ` (${agent.current_tool})` : ""}`}
    >
      {/* The character floats above a glowing desk pad. */}
      <div className="relative flex flex-col items-center">
        <span
          className={`room-bob ${wall ? "text-6xl xl:text-7xl" : "text-4xl"}`}
          style={{ animationDelay: `${(index % 5) * 0.35}s` }}
          role="img"
          aria-label={casting.role}
        >
          {casting.emoji}
        </span>
        <div
          className={`rounded-[50%] ${wall ? "w-20 h-3.5" : "w-12 h-2.5"} mt-1`}
          style={{
            background: `radial-gradient(ellipse at center, ${casting.tone}55 0%, transparent 70%)`,
          }}
        />
      </div>
      <span
        className={`${wall ? "text-sm" : "text-[11px]"} text-gray-300 max-w-[9rem] truncate font-medium`}
      >
        {label}
      </span>
      <span
        className={`${wall ? "text-xs" : "text-[10px]"} font-mono px-2 py-0.5 rounded-full border`}
        style={{
          color: casting.tone,
          borderColor: `${casting.tone}44`,
          backgroundColor: `${casting.tone}12`,
        }}
      >
        {casting.role}
        {agent.status === "working" && agent.current_tool ? ` · ${agent.current_tool}` : ""}
      </span>
    </button>
  );
}

export function AgentRoom({
  agents,
  sessionsById,
  size = "panel",
}: {
  agents: Agent[];
  sessionsById?: Map<string, Session>;
  size?: "panel" | "wall";
}) {
  const navigate = useNavigate();
  const wall = size === "wall";
  const active = agents.filter((a) => a.status === "working" || a.status === "waiting");

  const labelFor = (a: Agent) => {
    const sname = sessionsById?.get(a.session_id)?.name?.trim() || "";
    const isAuto = /^Session [0-9a-f]{8}$/i.test(sname);
    if (a.type === "subagent") return a.subagent_type || a.name;
    return sname && !isAuto ? sname : a.name;
  };

  if (active.length === 0) {
    return (
      <div className="room-floor flex flex-col items-center justify-center gap-2 rounded-2xl py-14 h-full">
        <span
          className={`${wall ? "text-6xl" : "text-4xl"} opacity-40`}
          role="img"
          aria-label="empty room"
        >
          🛋️
        </span>
        <p className={`${wall ? "text-lg" : "text-sm"} text-gray-500`}>
          The room is empty — no agents on shift.
        </p>
      </div>
    );
  }

  return (
    <div className={`room-floor rounded-2xl h-full ${wall ? "p-8" : "p-4"}`}>
      <div
        className={`flex flex-wrap items-end justify-center ${wall ? "gap-10" : "gap-4"} h-full content-center`}
      >
        {active.slice(0, wall ? 12 : 18).map((a, i) => (
          <Desk
            key={a.id}
            agent={a}
            casting={castAgent(a)}
            label={labelFor(a)}
            size={size}
            index={i}
            // Wall is read-only by contract - no navigation there.
            onClick={wall ? undefined : () => navigate(`/sessions/${a.session_id}`)}
          />
        ))}
      </div>
    </div>
  );
}
