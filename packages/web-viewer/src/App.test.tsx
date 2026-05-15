import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import App from "./App.js";

describe("App (drop-zone smoke test)", () => {
  beforeEach(() => {
    // Make sure no leftover ?bundle=... query param triggers the auto-load
    // effect from a sibling test. happy-dom shares window between tests.
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the idle drop-zone with the documented testid", () => {
    render(<App />);
    const dropZone = screen.getByTestId("drop-zone");
    expect(dropZone).toBeTruthy();
    expect(dropZone.className).toContain("drop-zone");
    expect(dropZone.className).not.toContain("active");
  });

  it("shows the AgentGit Web Viewer heading and read-only disclaimer in the idle state", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /AgentGit Web Viewer/i })).toBeTruthy();
    expect(screen.getByText(/Read-only/i)).toBeTruthy();
    expect(screen.getByText(/Drop a/i)).toBeTruthy();
  });
});
