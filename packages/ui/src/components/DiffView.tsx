import { diff_match_patch } from "diff-match-patch";
import React, { useMemo } from "react";
import type { CommitRow, DiffResult } from "../types.js";

interface Props {
  diff: DiffResult | null;
  selectedCommit: CommitRow | null;
}

const dmp = new diff_match_patch();

function computeTextDiff(a: string, b: string) {
  return dmp.diff_main(a, b);
}

export default function DiffView({ diff, selectedCommit }: Props) {
  const { left, right } = useMemo(() => {
    const tc1Raw = diff?.commit1_tool_call ?? selectedCommit?.tool_call ?? null;
    const tc2Raw = diff?.commit2_tool_call ?? null;

    let tc1 = "";
    let tc2 = "";

    try {
      tc1 = tc1Raw ? JSON.stringify(JSON.parse(tc1Raw), null, 2) : "";
    } catch {
      tc1 = tc1Raw ?? "";
    }

    try {
      tc2 = tc2Raw ? JSON.stringify(JSON.parse(tc2Raw), null, 2) : "";
    } catch {
      tc2 = tc2Raw ?? "";
    }

    if (!tc1 && !tc2) return { left: null, right: null };

    // If we have diff (compare mode), compute side-by-side diff
    if (diff && tc2) {
      const patches = computeTextDiff(tc1, tc2);
      dmp.diff_cleanupSemantic(patches);
      return { left: tc1, right: { patches, tc2 } };
    }

    // Single commit view — just show the tool call
    return { left: tc1, right: null };
  }, [diff, selectedCommit]);

  if (!left && !right) {
    return <div className="empty-state">Select two commits (right-click a tick to set compare)</div>;
  }

  if (!right) {
    return (
      <div style={{ padding: 12, overflowX: "auto" }}>
        <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{left}</pre>
      </div>
    );
  }

  const { patches } = right as { patches: [number, string][]; tc2: string };

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }} data-testid="diff-view">
      <div style={{ flex: 1, overflow: "auto", padding: 8, borderRight: "1px solid var(--border)" }}>
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Before</div>
        <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
          {patches.map((seg, i) => {
            const [op, text] = seg;
            if (op === -1) {
              return (
                <span key={i} style={{ background: "#5c1010", color: "#ffaaaa" }}>
                  {text}
                </span>
              );
            }
            if (op === 0) return <span key={i}>{text}</span>;
            return null;
          })}
        </pre>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>After</div>
        <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
          {patches.map((seg, i) => {
            const [op, text] = seg;
            if (op === 1) {
              return (
                <span key={i} style={{ background: "#1a4020", color: "#aaffaa" }}>
                  {text}
                </span>
              );
            }
            if (op === 0) return <span key={i}>{text}</span>;
            return null;
          })}
        </pre>
      </div>
    </div>
  );
}
