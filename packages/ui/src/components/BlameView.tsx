import React from "react";
import type { BlameEntry } from "../types.js";

interface Props {
  entries: BlameEntry[];
}

function shortHash(h: string) {
  return h.slice(0, 8);
}

export default function BlameView({ entries }: Props) {
  if (entries.length === 0) {
    return <div className="empty-state">No blame data</div>;
  }

  return (
    <table
      data-testid="blame-view"
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 12,
      }}
    >
      <thead>
        <tr style={{ borderBottom: "1px solid var(--border)" }}>
          {["Path", "Last commit", "Message", "When"].map((h) => (
            <th
              key={h}
              style={{
                textAlign: "left",
                padding: "4px 8px",
                fontSize: 10,
                color: "var(--text-muted)",
                fontWeight: "normal",
                position: "sticky",
                top: 0,
                background: "var(--surface)",
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.path} style={{ borderBottom: "1px solid var(--border)" }}>
            <td style={{ padding: "4px 8px", color: "var(--text)", fontFamily: "monospace" }}>{e.path}</td>
            <td style={{ padding: "4px 8px", color: "var(--accent)", fontFamily: "monospace" }}>{shortHash(e.commit_hash)}</td>
            <td
              style={{
                padding: "4px 8px",
                color: "var(--text-muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 160,
              }}
            >
              {e.message}
            </td>
            <td style={{ padding: "4px 8px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              {new Date(e.timestamp).toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
