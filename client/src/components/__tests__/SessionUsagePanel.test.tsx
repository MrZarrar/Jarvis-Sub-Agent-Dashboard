import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionUsagePanel } from "../SessionUsagePanel";
import type { CodexUsage, SessionWindow } from "../../lib/types";

const claude: SessionWindow = {
  active: true,
  startedAt: "2026-08-15T08:00:00.000Z",
  resetsAt: "2026-08-15T13:00:00.000Z",
  eventsInWindow: 42,
  source: "real",
  status: "allowed",
  isUsingOverage: false,
  probeAgeMs: 1_000,
  percentUsed: 38,
  sampleAgeMs: 1_000,
  sampleSource: "organic",
};

const codex: CodexUsage = {
  fiveHour: { usedPercent: 24, remainingPercent: 76, resetsAt: "2026-08-15T14:00:00.000Z" },
  weekly: { usedPercent: 61, remainingPercent: 39, resetsAt: "2026-08-18T00:00:00.000Z" },
  fetchedAt: "2026-08-15T10:00:00.000Z",
};

describe("SessionUsagePanel", () => {
  it("shows Claude five-hour and both Codex limits", () => {
    render(<SessionUsagePanel claude={claude} codex={codex} />);

    expect(screen.getByRole("heading", { name: "Session usage" })).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("38% used")).toBeInTheDocument();
    expect(screen.getByText("Codex 5h")).toBeInTheDocument();
    expect(screen.getByText("24% used")).toBeInTheDocument();
    expect(screen.getByText("Codex weekly")).toBeInTheDocument();
    expect(screen.getByText("61% used")).toBeInTheDocument();
  });

  it("keeps one provider useful when the other is unavailable", () => {
    render(<SessionUsagePanel claude={claude} codex={null} codexUnavailable />);

    expect(screen.getByText("38% used")).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
  });

  it("does not invent Claude percentage data", () => {
    render(<SessionUsagePanel claude={{ ...claude, percentUsed: null }} codex={codex} />);

    expect(screen.getByText("Usage unavailable")).toBeInTheDocument();
  });
});
