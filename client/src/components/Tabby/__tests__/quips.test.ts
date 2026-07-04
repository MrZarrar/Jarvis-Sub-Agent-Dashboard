import { describe, it, expect } from "vitest";
import { pickQuip, ALL_QUIP_KEYS } from "../quips";

describe("pickQuip", () => {
  it("returns a non-empty string for every known key", () => {
    for (const key of ALL_QUIP_KEYS) {
      expect(pickQuip(key, () => 0).length).toBeGreaterThan(0);
    }
  });

  it("is deterministic given an injected rand", () => {
    expect(pickQuip("session_done", () => 0)).toBe(pickQuip("session_done", () => 0));
  });

  it("rand=0.999 stays within bounds (no out-of-range index)", () => {
    for (const key of ALL_QUIP_KEYS) {
      expect(typeof pickQuip(key, () => 0.999)).toBe("string");
      expect(pickQuip(key, () => 0.999).length).toBeGreaterThan(0);
    }
  });

  it("returns empty string for an unknown key without throwing", () => {
    // @ts-expect-error intentionally passing an invalid key
    expect(pickQuip("nope", () => 0)).toBe("");
  });

  it("ultron mode yields a non-empty, distinct voice for every key", () => {
    for (const key of ALL_QUIP_KEYS) {
      const ultron = pickQuip(key, () => 0, "ultron");
      const jarvis = pickQuip(key, () => 0, "jarvis");
      expect(ultron.length).toBeGreaterThan(0);
      // Every key has an ultron override, so the voices differ.
      expect(ultron).not.toBe(jarvis);
    }
  });

  it("defaults to the jarvis voice when no mode is given", () => {
    expect(pickQuip("idle", () => 0)).toBe(pickQuip("idle", () => 0, "jarvis"));
  });
});
