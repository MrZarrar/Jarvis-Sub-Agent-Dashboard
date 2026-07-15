import { render, screen } from "@testing-library/react";
import { Bot } from "lucide-react";
import { describe, expect, it } from "vitest";
import { HoloOrbit } from "../HoloOrbit";

describe("HoloOrbit", () => {
  it("shows active sessions from both providers", () => {
    render(<HoloOrbit label="Active Sessions" icon={Bot} claude={2} codex={1} />);

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2 Claude")).toBeInTheDocument();
    expect(screen.getByText("1 GPT")).toBeInTheDocument();
  });

  it("keeps both providers visible when the orbit is capped", () => {
    const { container } = render(
      <HoloOrbit label="Active Sessions" icon={Bot} claude={100} codex={1} />
    );

    expect(container.querySelectorAll('circle[fill="#22d3ee"]')).toHaveLength(1);
  });
});
