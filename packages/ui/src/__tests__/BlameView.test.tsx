import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import BlameView from "../components/BlameView.js";
import { FIXTURE_BLAME } from "./fixtures.js";

describe("BlameView", () => {
  it("shows empty state when no entries", () => {
    render(<BlameView entries={[]} />);
    expect(screen.getByText("No blame data")).toBeInTheDocument();
  });

  it("renders one row per blame entry", () => {
    render(<BlameView entries={FIXTURE_BLAME} />);
    expect(screen.getByTestId("blame-view")).toBeInTheDocument();
    expect(screen.getByText("files/main.py")).toBeInTheDocument();
  });

  it("shows shortened commit hash", () => {
    render(<BlameView entries={FIXTURE_BLAME} />);
    expect(screen.getByText(FIXTURE_BLAME[0]!.commit_hash.slice(0, 8))).toBeInTheDocument();
  });

  it("shows commit message", () => {
    render(<BlameView entries={FIXTURE_BLAME} />);
    expect(screen.getByText("write file")).toBeInTheDocument();
  });
});
