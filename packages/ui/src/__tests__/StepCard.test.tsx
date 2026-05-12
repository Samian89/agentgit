import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import StepCard from "../components/StepCard.js";
import { FIXTURE_COMMITS } from "./fixtures.js";

const COMMIT = FIXTURE_COMMITS[0]!;

describe("StepCard", () => {
  it("renders commit message", () => {
    render(<StepCard commit={COMMIT} selected={false} onSelect={vi.fn()} />);
    expect(screen.getByText("read file")).toBeInTheDocument();
  });

  it("renders tool call name", () => {
    render(<StepCard commit={COMMIT} selected={false} onSelect={vi.fn()} />);
    expect(screen.getByText("read_file")).toBeInTheDocument();
  });

  it("expands detail on click", async () => {
    render(<StepCard commit={COMMIT} selected={false} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("step-card-detail")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("step-card"));
    expect(screen.getByTestId("step-card-detail")).toBeInTheDocument();
    expect(screen.getByText("Tool")).toBeInTheDocument();
  });

  it("applies selected style when selected=true", () => {
    render(<StepCard commit={COMMIT} selected={true} onSelect={vi.fn()} />);
    const card = screen.getByTestId("step-card");
    expect(card.getAttribute("style")).toContain("var(--selected)");
  });

  it("calls onSelect when clicked", async () => {
    const onSelect = vi.fn();
    render(<StepCard commit={COMMIT} selected={false} onSelect={onSelect} />);
    await userEvent.click(screen.getByTestId("step-card"));
    expect(onSelect).toHaveBeenCalled();
  });
});
