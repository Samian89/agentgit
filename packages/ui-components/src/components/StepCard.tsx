import React, { useState } from "react";
import type { CommitRow, LlmCall, ToolCall } from "../types.js";

interface Props {
  commit: CommitRow;
  selected: boolean;
  onSelect: () => void;
}

function shortHash(h: string) {
  return h.slice(0, 8);
}

function parseToolCall(raw: string | null): ToolCall | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ToolCall;
  } catch {
    return null;
  }
}

function parseLlmCall(raw: string | null): LlmCall | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LlmCall;
  } catch {
    return null;
  }
}

function getLastUserMessage(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content;
  }
  const last = messages[messages.length - 1];
  return last?.content ?? "";
}

const cardStyle = (selected: boolean): React.CSSProperties => ({
  borderBottom: "1px solid var(--border)",
  background: selected ? "var(--selected)" : "transparent",
  cursor: "pointer",
});

export default function StepCard({ commit, selected, onSelect }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showFullPrompt, setShowFullPrompt] = useState(false);
  const [showFullResponse, setShowFullResponse] = useState(false);
  const tc = parseToolCall(commit.tool_call);
  const lc = parseLlmCall(commit.llm_call);
  const llmPrompt = lc ? getLastUserMessage(lc.messages) : "";
  const llmResponse = lc ? lc.response : "";

  return (
    <div
      data-testid="step-card"
      style={cardStyle(selected)}
      onClick={() => { onSelect(); setExpanded((v) => !v); }}
    >
      <div style={{ padding: "8px 12px", display: "flex", gap: 8, alignItems: "flex-start" }}>
        <span style={{ color: "var(--text-muted)", fontSize: 10, paddingTop: 2, flexShrink: 0 }}>
          {shortHash(commit.hash)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {commit.message}
          </div>
          {tc && (
            <div style={{ fontSize: 11, color: "var(--accent)", marginTop: 2 }}>
              {tc.name}
            </div>
          )}
          {lc && (
            <div style={{ fontSize: 11, color: "var(--llm-accent)", marginTop: 2 }}>
              llm: {lc.model} · {lc.usage?.totalTokens ?? "?"} tok
              {lc.costEstimateUsd !== null && ` · ~$${lc.costEstimateUsd.toFixed(4)}`}
            </div>
          )}
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
            {new Date(commit.timestamp).toLocaleString()}
          </div>
        </div>
        <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <div style={{ padding: "0 12px 10px 12px" }} data-testid="step-card-detail">
          {tc && (
            <>
              <Row label="Tool" value={tc.name} />
              <Row label="Status" value={tc.status} />
              {tc.input && (
                <Row label="Input" value={JSON.stringify(tc.input, null, 2)} mono />
              )}
              {tc.output !== null && (
                <Row label="Output" value={String(tc.output)} mono />
              )}
              {tc.error && <Row label="Error" value={tc.error} />}
            </>
          )}
          {lc && (
            <>
              <Row label="Provider" value={lc.provider} />
              <Row label="Model" value={lc.model} />
              <Row label="Status" value={lc.status} />
              {lc.usage && (
                <Row
                  label="Usage"
                  value={`prompt ${lc.usage.promptTokens} · completion ${lc.usage.completionTokens} · total ${lc.usage.totalTokens}`}
                />
              )}
              {lc.durationMs !== null && <Row label="Duration" value={`${lc.durationMs} ms`} />}
              {lc.costEstimateUsd !== null && (
                <Row label="Cost (est.)" value={`~$${lc.costEstimateUsd.toFixed(6)}`} />
              )}
              {lc.error && <Row label="Error" value={lc.error} />}
              {llmPrompt && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>
                    Prompt (last user)
                  </div>
                  <pre
                    style={{
                      fontSize: 11,
                      background: "var(--bg)",
                      padding: "4px 6px",
                      borderRadius: 3,
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      maxHeight: 120,
                      overflowY: "auto",
                    }}
                  >
                    {llmPrompt.length > 800 && !showFullPrompt
                      ? llmPrompt.slice(0, 800) + "..."
                      : llmPrompt}
                  </pre>
                  {llmPrompt.length > 800 && (
                    <button
                      style={{ fontSize: 10, padding: "2px 6px", marginTop: 2 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowFullPrompt((v) => !v);
                      }}
                    >
                      {showFullPrompt ? "show less" : "show more"}
                    </button>
                  )}
                </div>
              )}
              {llmResponse && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>
                    Response
                  </div>
                  <pre
                    style={{
                      fontSize: 11,
                      background: "var(--bg)",
                      padding: "4px 6px",
                      borderRadius: 3,
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      maxHeight: 120,
                      overflowY: "auto",
                    }}
                  >
                    {llmResponse.length > 800 && !showFullResponse
                      ? llmResponse.slice(0, 800) + "..."
                      : llmResponse}
                  </pre>
                  {llmResponse.length > 800 && (
                    <button
                      style={{ fontSize: 10, padding: "2px 6px", marginTop: 2 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowFullResponse((v) => !v);
                      }}
                    >
                      {showFullResponse ? "show less" : "show more"}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {!tc && !lc && (
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No tool call</p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>{label}</div>
      <pre style={{
        fontSize: 11,
        background: "var(--bg)",
        padding: "4px 6px",
        borderRadius: 3,
        overflowX: "auto",
        whiteSpace: mono ? "pre" : "pre-wrap",
        wordBreak: "break-all",
        maxHeight: 120,
        overflowY: "auto",
      }}>
        {value}
      </pre>
    </div>
  );
}
