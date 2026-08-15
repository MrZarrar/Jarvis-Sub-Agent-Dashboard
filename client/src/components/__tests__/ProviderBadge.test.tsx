/**
 * Regression guard for the Mac-to-PC migration: session rows carry a
 * `provider` field, and a non-Claude provider must be visible. The badge was
 * dropped during the migration while the data kept flowing, so a Codex session
 * was indistinguishable from a Claude one in the UI.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderBadge } from "../StatusBadge";

describe("ProviderBadge", () => {
  it("labels a non-Claude session with its provider", () => {
    render(<ProviderBadge provider="codex" />);
    expect(screen.getByText("codex")).toBeTruthy();
  });

  it("stays silent for Claude and for sessions with no provider", () => {
    // Claude is the historical default: badging it would relabel every
    // pre-existing session for no information gain.
    const { container: claude } = render(<ProviderBadge provider="claude" />);
    expect(claude.firstChild).toBeNull();

    const { container: none } = render(<ProviderBadge />);
    expect(none.firstChild).toBeNull();
  });
});
