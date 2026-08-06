import { afterEach, describe, expect, it } from "vitest";
import { applyRoomSkin, roleForAgent, TEAM } from "../AgentRoom";
import type { Agent } from "../../lib/types";

afterEach(() => applyRoomSkin("dev"));

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
