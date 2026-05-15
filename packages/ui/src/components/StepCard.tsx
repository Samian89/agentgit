import React from "react";
import { StepCard as BaseStepCard } from "@agentgit/ui-components";
import { CommitContextMenu } from "./CommitContextMenu.js";
import type { CommitRow } from "../types.js";

interface StepCardProps {
  commit: CommitRow;
  selected: boolean;
  onSelect: () => void;
  onReplay?: (commit: CommitRow) => void;
  onExportBundle?: (commit: CommitRow) => void;
}

/**
 * Local wrapper around the shared StepCard that optionally attaches a Radix
 * right-click context menu for Replay / Export actions (wired from App).
 * Falls back to plain shared card when handlers are not provided (keeps tests green).
 */
export default function StepCard(props: StepCardProps) {
  const { onReplay, onExportBundle, ...baseProps } = props;
  const card = <BaseStepCard {...baseProps} />;

  if (onReplay || onExportBundle) {
    return (
      <CommitContextMenu
        commit={props.commit}
        onReplay={onReplay}
        onExportBundle={onExportBundle}
      >
        {card}
      </CommitContextMenu>
    );
  }
  return card;
}
