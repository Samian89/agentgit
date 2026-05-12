import React from "react";
import type { CommitRow } from "../types.js";

interface Props {
  commits: CommitRow[];
  selectedHash: string | null;
  compareHash: string | null;
  onSelect: (hash: string) => void;
  onCompare: (hash: string | null) => void;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    padding: "12px 16px",
    gap: 2,
    background: "var(--surface)",
    borderBottom: "1px solid var(--border)",
    overflowX: "auto",
    flexShrink: 0,
    minHeight: 52,
  },
  empty: {
    color: "var(--text-muted)",
    fontSize: 12,
    padding: "0 4px",
  },
  label: {
    fontSize: 10,
    color: "var(--text-muted)",
    marginRight: 8,
    flexShrink: 0,
  },
};

function tickStyle(isSelected: boolean, isCompare: boolean): React.CSSProperties {
  return {
    width: 14,
    height: 28,
    borderRadius: 3,
    cursor: "pointer",
    background: isSelected ? "var(--accent)" : isCompare ? "#0f3460" : "var(--border)",
    border: isSelected || isCompare ? "2px solid var(--accent)" : "2px solid transparent",
    flexShrink: 0,
    transition: "background 0.1s",
  };
}

export default function TimelineScrollbar({ commits, selectedHash, compareHash, onSelect, onCompare }: Props) {
  if (commits.length === 0) {
    return (
      <div style={styles.container}>
        <span style={styles.empty}>No commits in timeline</span>
      </div>
    );
  }

  return (
    <div style={styles.container} role="listbox" aria-label="commit timeline">
      <span style={styles.label}>Timeline:</span>
      {commits.map((c, i) => {
        const isSelected = c.hash === selectedHash;
        const isCompare = c.hash === compareHash;
        return (
          <div
            key={c.hash}
            role="option"
            aria-selected={isSelected}
            data-hash={c.hash}
            title={`${i + 1}: ${c.message}\n${new Date(c.timestamp).toISOString()}\nLeft-click: select  Right-click: set compare`}
            style={tickStyle(isSelected, isCompare)}
            onClick={() => onSelect(c.hash)}
            onContextMenu={(e) => {
              e.preventDefault();
              onCompare(isCompare ? null : c.hash);
            }}
          />
        );
      })}
    </div>
  );
}
