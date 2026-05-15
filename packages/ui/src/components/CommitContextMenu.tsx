import React from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { CommitRow } from "../types.js";

export interface CommitContextMenuProps {
  commit: CommitRow;
  onReplay?: (commit: CommitRow) => void;
  onExportBundle?: (commit: CommitRow) => void;
  children: React.ReactNode;
}

/**
 * Wraps a commit row (StepCard) with a right-click context menu providing
 * "Replay from here" and "Export as .agentgit-bundle".
 * The trigger preserves the child's click/expand behavior for left-click.
 */
export function CommitContextMenu({
  commit,
  onReplay,
  onExportBundle,
  children,
}: CommitContextMenuProps) {
  const hasActions = Boolean(onReplay || onExportBundle);

  if (!hasActions) {
    return <>{children}</>;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div style={{ display: "contents" }}>{children}</div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          style={{
            minWidth: 200,
            background: "var(--bg, #fff)",
            border: "1px solid var(--border, #ccc)",
            borderRadius: 6,
            padding: 4,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 1000,
          }}
        >
          {onReplay && (
            <ContextMenu.Item
              onSelect={() => onReplay(commit)}
              style={{
                padding: "6px 10px",
                fontSize: 13,
                borderRadius: 4,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "var(--selected, #f0f0f0)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "transparent";
              }}
            >
              Replay from here
            </ContextMenu.Item>
          )}
          {onReplay && onExportBundle && (
            <div
              style={{ height: 1, background: "var(--border, #eee)", margin: "4px 0" }}
            />
          )}
          {onExportBundle && (
            <ContextMenu.Item
              onSelect={() => onExportBundle(commit)}
              style={{
                padding: "6px 10px",
                fontSize: 13,
                borderRadius: 4,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "var(--selected, #f0f0f0)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "transparent";
              }}
            >
              Export as .agentgit-bundle
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export default CommitContextMenu;
