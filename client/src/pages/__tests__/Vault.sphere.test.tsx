/**
 * Regression guard for the Mac-to-PC migration: the Vault must render the
 * Three.js sphere-brain (components/VaultSphere), not the page-level 2D D3
 * force graph it was reverted to. The sphere component is stubbed so this never
 * needs a WebGL context - the assertion is about which renderer the page wires
 * up, which is exactly what regressed.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../components/VaultSphere", () => ({
  VaultSphere: (props: Record<string, unknown>) => (
    <div
      data-testid="vault-sphere"
      data-node-count={Array.isArray(props.nodes) ? props.nodes.length : 0}
      data-edge-count={Array.isArray(props.edges) ? props.edges.length : 0}
      data-has-fx={props.fx ? "yes" : "no"}
      data-has-recall={props.recallIds instanceof Set ? "yes" : "no"}
      data-has-focus={typeof props.onFocus === "function" ? "yes" : "no"}
      data-has-select={typeof props.onSelect === "function" ? "yes" : "no"}
    />
  ),
}));

import { Vault } from "../Vault";

const graph = {
  nodes: [
    { id: "n1", title: "Alpha", type: "note" },
    { id: "n2", title: "Beta", type: "project" },
  ],
  edges: [{ src: "n1", dst: "n2", type: "link" }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/vault/graph")) return Promise.resolve(jsonResponse(graph));
    if (url.includes("/vault/recall")) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes("/vault/engine/status")) {
      return Promise.resolve(
        jsonResponse({
          running: false,
          cancelling: false,
          lastRun: null,
          totalEntities: 0,
          promotedEntities: 0,
        })
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderVault() {
  return render(
    <MemoryRouter initialEntries={["/vault"]}>
      <Vault />
    </MemoryRouter>
  );
}

describe("Vault renderer", () => {
  it("renders the Three.js sphere and not a page-level 2D graph canvas", async () => {
    const { container } = renderVault();

    const sphere = await screen.findByTestId("vault-sphere");
    expect(sphere).toBeTruthy();

    // The regression was a <canvas> driven by a d3 force simulation living in
    // the page itself. VaultSphere owns its own canvas internally, but it is
    // stubbed here - so any canvas still in the tree is the old 2D renderer.
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("feeds the sphere the live graph plus recall, fx and interaction wiring", async () => {
    renderVault();

    const sphere = await screen.findByTestId("vault-sphere");
    await waitFor(() => expect(sphere.getAttribute("data-node-count")).toBe("2"));

    expect(sphere.getAttribute("data-edge-count")).toBe("1");
    // Engine effects, recall highlighting and focus/select must survive the
    // renderer swap - these were the behaviours at risk of being dropped.
    expect(sphere.getAttribute("data-has-fx")).toBe("yes");
    expect(sphere.getAttribute("data-has-recall")).toBe("yes");
    expect(sphere.getAttribute("data-has-focus")).toBe("yes");
    expect(sphere.getAttribute("data-has-select")).toBe("yes");
  });
});
