/**
 * @file AgentRoom.test.tsx
 * @description The two things that break silently in the Ops Room: a sprite
 * grid row that isn't 12 px wide (shifts every pixel below it) or references a
 * color the character doesn't define, and the name-first agent→desk routing.
 */

import { describe, expect, it } from "vitest";
import { TEAM, latestTodos, roleForAgent, stepToward, type CharState } from "../AgentRoom";
import type { Agent, DashboardEvent } from "../../lib/types";

function agent(partial: Partial<Agent>): Agent {
  return {
    id: "a1",
    session_id: "s1",
    name: "",
    type: "subagent",
    subagent_type: null,
    status: "working",
    task: null,
    current_tool: null,
    parent_agent_id: null,
    metadata: null,
    started_at: "",
    ended_at: null,
    ...partial,
  } as Agent;
}

describe("sprite grids", () => {
  it("every row is 12 wide and every mark has a color", () => {
    for (const role of TEAM) {
      const { colors, body, legsStand, legsWalk } = role.sprite;
      for (const row of [...body, ...legsStand, ...legsWalk]) {
        expect(row, `${role.id}: "${row}"`).toHaveLength(12);
        for (const ch of row) {
          if (ch === ".") continue;
          expect(colors[ch], `${role.id}: no color for "${ch}"`).toBeTruthy();
        }
      }
    }
  });

  it("each teammate has a distinct silhouette (no shared body grid)", () => {
    const bodies = new Set(TEAM.map((r) => r.sprite.body.join("\n")));
    expect(bodies.size).toBe(TEAM.length);
  });
});

describe("stepToward", () => {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;

  it("lands EXACTLY on target so the ≤1 settled check fires (the freeze bug)", () => {
    // A diagonal target where per-axis stopping would otherwise leave a ~2px
    // combined gap and strand the character mid-floor forever.
    const ch: CharState = { x: 0, y: 0, tx: 37, ty: 41, act: "chat", idleUntil: 0 };
    for (let i = 0; i < 1000 && !(ch.x === ch.tx && ch.y === ch.ty); i++) {
      stepToward(ch, 2.18); // low-framerate step (dt capped at 64ms)
    }
    expect(ch.x).toBe(ch.tx);
    expect(ch.y).toBe(ch.ty);
    expect(Math.abs(ch.x - ch.tx) + Math.abs(ch.y - ch.ty)).toBeLessThanOrEqual(1);
  });

  it("walks x before y (L-shaped path)", () => {
    const ch: CharState = { x: 0, y: 0, tx: 40, ty: 40, act: "chat", idleUntil: 0 };
    stepToward(ch, 5);
    expect(ch.x).toBeGreaterThan(0);
    expect(ch.y).toBe(0);
  });

  it("does not overshoot when already at target", () => {
    const ch: CharState = { x: 10, y: 20, tx: 10, ty: 20, act: "nap", idleUntil: 0 };
    stepToward(ch, 5);
    expect(near(ch.x, 10) && near(ch.y, 20)).toBe(true);
  });
});

describe("latestTodos", () => {
  const ev = (partial: Partial<DashboardEvent>): DashboardEvent =>
    ({
      id: 1,
      session_id: "s1",
      agent_id: null,
      event_type: "PostToolUse",
      tool_name: "TodoWrite",
      summary: null,
      data: null,
      created_at: "",
      ...partial,
    }) as DashboardEvent;

  it("splits the newest TodoWrite in the given sessions into done/doing/next", () => {
    const events = [
      // Newest first (the shape the dashboard polls). First match wins.
      ev({
        id: 3,
        data: JSON.stringify({
          tool_input: {
            todos: [
              { content: "ship it", status: "completed" },
              { content: "test it", status: "in_progress" },
              { content: "doc it", status: "pending" },
            ],
          },
        }),
      }),
      ev({
        id: 2,
        data: JSON.stringify({ tool_input: { todos: [{ content: "stale", status: "pending" }] } }),
      }),
      ev({ id: 1, session_id: "other", data: JSON.stringify({ tool_input: { todos: [] } }) }),
    ];
    expect(latestTodos(events, new Set(["s1"]))).toEqual({
      done: ["ship it"],
      doing: ["test it"],
      next: ["doc it"],
    });
  });

  it("returns null on wrong sessions, non-todo tools, or malformed data", () => {
    expect(latestTodos([ev({ data: "{not json" })], new Set(["s1"]))).toBeNull();
    expect(latestTodos([ev({ tool_name: "Bash" })], new Set(["s1"]))).toBeNull();
    expect(latestTodos([ev({})], new Set(["s2"]))).toBeNull();
  });
});

describe("roleForAgent", () => {
  it("routes named team delegations to the right desk", () => {
    expect(roleForAgent(agent({ subagent_type: "scout" }))).toBe("scout");
    expect(roleForAgent(agent({ subagent_type: "forge" }))).toBe("forge");
    expect(roleForAgent(agent({ subagent_type: "sentinel" }))).toBe("sentinel");
    expect(roleForAgent(agent({ subagent_type: "ops" }))).toBe("ops");
  });

  it("routes aliases and reviewer-ish subagents", () => {
    expect(roleForAgent(agent({ name: "Sherlock", subagent_type: "Explore" }))).toBe("scout");
    expect(roleForAgent(agent({ subagent_type: "backend-reviewer" }))).toBe("sentinel");
    expect(roleForAgent(agent({ subagent_type: "lie-detector:AGENTS" }))).toBe("sentinel");
    expect(roleForAgent(agent({ name: "Ops Robot", subagent_type: "general-purpose" }))).toBe(
      "ops"
    );
  });

  it("falls back to tool, then main→jarvis / subagent→scout", () => {
    expect(roleForAgent(agent({ current_tool: "Edit" }))).toBe("forge");
    expect(roleForAgent(agent({ current_tool: "Bash" }))).toBe("ops");
    expect(roleForAgent(agent({ type: "main" }))).toBe("jarvis");
    expect(roleForAgent(agent({}))).toBe("scout");
  });
});
