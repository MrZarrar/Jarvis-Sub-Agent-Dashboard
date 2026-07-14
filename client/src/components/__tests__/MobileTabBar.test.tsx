import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MobileTabBar } from "../MobileTabBar";

describe("MobileTabBar", () => {
  it("uses Dashboard as the default tab and leaves Today to the dashboard", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <MobileTabBar onMore={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("link", { name: "Today" })).not.toBeInTheDocument();
  });
});
