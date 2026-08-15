/**
 * The two things that break silently in the Ops Room: a sprite grid row that
 * isn't 12 px wide (shifts every pixel below it) or references a color the
 * character doesn't define, and the name-first agent to desk routing.
 *
 * The sprite and movement blocks were lost in the Mac-to-PC migration while
 * the code they cover survived, so they are restored here alongside the newer
 * business-skin tests.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  applyRoomSkin,
  idleSpotsFor,
  latestTodos,
  roleForAgent,
  roomSpriteFor,
  stepToward,
  TEAM,
  type CharState,
} from "../AgentRoom";
import type { Agent } from "../../lib/types";

afterEach(() => applyRoomSkin("dev"));

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

describe("AgentRoom business crew", () => {
  it("re-skins the existing desks without changing their identities", () => {
    const ids = TEAM.map((role) => role.id);

    applyRoomSkin("business");

    expect(TEAM.map((role) => role.id)).toEqual(ids);
    expect(TEAM.find((role) => role.id === "scout")?.name).toBe("Deal Scout");
    expect(TEAM.find((role) => role.id === "sentinel")?.name).toBe("Underwriter");
    expect(TEAM.find((role) => role.id === "ops")?.name).toBe("Bookkeeper");
  });

  it("routes business agent names to the corresponding desks", () => {
    const agent = (name: string) => ({ name, type: "subagent" }) as Agent;
    expect(roleForAgent(agent("deal-scout"))).toBe("scout");
    expect(roleForAgent(agent("listing-writer"))).toBe("forge");
    expect(roleForAgent(agent("underwriter"))).toBe("sentinel");
    expect(roleForAgent(agent("bookkeeper"))).toBe("ops");
  });
});

describe("restored Ops Room details", () => {
  it("mines the newest TodoWrite snapshot for the selected desk", () => {
    const event = (id: number, data: string) =>
      ({
        id,
        session_id: "session-1",
        agent_id: "agent-1",
        event_type: "PreToolUse",
        tool_name: "TodoWrite",
        summary: null,
        data,
        created_at: "2026-08-15T10:00:00.000Z",
      }) as const;
    const newer = event(
      2,
      JSON.stringify({
        tool_input: {
          todos: [
            { content: "Ship panel", status: "in_progress" },
            { content: "Run build", status: "pending" },
            { content: "Write tests", status: "completed" },
          ],
        },
      })
    );
    const older = event(
      1,
      JSON.stringify({ tool_input: { todos: [{ content: "Stale task", status: "pending" }] } })
    );

    expect(latestTodos([newer, older], new Set(["session-1"]))).toEqual({
      done: ["Write tests"],
      doing: ["Ship panel"],
      next: ["Run build"],
    });
  });

  it("gives Sentinel a batcave nap and swaps Jarvis to a larger Ultron sprite", () => {
    expect(idleSpotsFor("sentinel").find((spot) => spot.act === "nap")).not.toEqual(
      idleSpotsFor("jarvis").find((spot) => spot.act === "nap")
    );
    expect(roomSpriteFor("jarvis", true).sprite).not.toBe(roomSpriteFor("jarvis", false).sprite);
    expect(roomSpriteFor("jarvis", true).scale).toBeGreaterThan(1);
  });
});
