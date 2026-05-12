import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import TimelineScrollbar from "../components/TimelineScrollbar.js";
import { FIXTURE_COMMITS, HASH_A, HASH_B } from "./fixtures.js";

describe("TimelineScrollbar", () => {
  it("renders empty state when no commits", () => {
    render(
      <TimelineScrollbar
        commits={[]}
        selectedHash={null}
        compareHash={null}
        onSelect={vi.fn()}
        onCompare={vi.fn()}
      />,
    );
    expect(screen.getByText("No commits in timeline")).toBeInTheDocument();
  });

  it("renders one tick per commit", () => {
    render(
      <TimelineScrollbar
        commits={FIXTURE_COMMITS}
        selectedHash={null}
        compareHash={null}
        onSelect={vi.fn()}
        onCompare={vi.fn()}
      />,
    );
    const ticks = screen.getAllByRole("option");
    expect(ticks).toHaveLength(FIXTURE_COMMITS.length);
  });

  it("marks selected commit with aria-selected", () => {
    render(
      <TimelineScrollbar
        commits={FIXTURE_COMMITS}
        selectedHash={HASH_A}
        compareHash={null}
        onSelect={vi.fn()}
        onCompare={vi.fn()}
      />,
    );
    const selected = screen.getAllByRole("option", { selected: true });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAttribute("data-hash", HASH_A);
  });

  it("calls onSelect when a tick is clicked", async () => {
    const onSelect = vi.fn();
    render(
      <TimelineScrollbar
        commits={FIXTURE_COMMITS}
        selectedHash={null}
        compareHash={null}
        onSelect={onSelect}
        onCompare={vi.fn()}
      />,
    );
    const ticks = screen.getAllByRole("option");
    await userEvent.click(ticks[1]!);
    expect(onSelect).toHaveBeenCalledWith(HASH_B);
  });
});
