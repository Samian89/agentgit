import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import DiffView from "../components/DiffView.js";
import { FIXTURE_COMMITS, FIXTURE_DIFF } from "./fixtures.js";

describe("DiffView", () => {
  it("shows empty state when no diff", () => {
    render(<DiffView diff={null} selectedCommit={null} />);
    expect(screen.getByText(/Select two commits/)).toBeInTheDocument();
  });

  it("renders diff panels when diff is provided", () => {
    render(<DiffView diff={FIXTURE_DIFF} selectedCommit={FIXTURE_COMMITS[0]!} />);
    expect(screen.getByTestId("diff-view")).toBeInTheDocument();
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("shows tool call content when only selectedCommit is set", () => {
    render(<DiffView diff={null} selectedCommit={FIXTURE_COMMITS[0]!} />);
    expect(screen.getByText(/read_file/)).toBeInTheDocument();
  });
});
