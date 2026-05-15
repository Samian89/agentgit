import React, { useState } from "react";
import { createSession } from "../ipc.js";
import type { SessionRow } from "../types.js";

export interface NewSessionModalProps {
  dbPath: string;
  onClose: () => void;
  onCreated?: (session: SessionRow) => void;
}

type Status = { kind: "idle" } | { kind: "creating" } | { kind: "error"; message: string };

/**
 * Modal for creating a brand new session via IPC.
 * Accepts free-form JSON metadata (defaults to {}).
 */
export function NewSessionModal({ dbPath, onClose, onCreated }: NewSessionModalProps) {
  const [name, setName] = useState("");
  const [metaText, setMetaText] = useState("{\n  \"agent\": \"manual\"\n}");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const handleCreate = async () => {
    if (!name.trim()) {
      setStatus({ kind: "error", message: "Session name is required" });
      return;
    }
    let metadata: Record<string, unknown> = {};
    try {
      metadata = metaText.trim() ? (JSON.parse(metaText) as Record<string, unknown>) : {};
    } catch (e) {
      setStatus({ kind: "error", message: "Invalid JSON in metadata" });
      return;
    }
    setStatus({ kind: "creating" });
    try {
      const row = await createSession(dbPath, name.trim(), metadata);
      setStatus({ kind: "idle" });
      onCreated?.(row);
      onClose();
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--bg, #fff)",
          border: "1px solid var(--border, #ccc)",
          borderRadius: 8,
          padding: 20,
          width: "min(420px, 92vw)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>New Session</h3>

        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-new-agent-run"
          style={{ width: "100%", padding: 8, margin: "4px 0 12px", boxSizing: "border-box" }}
          autoFocus
        />

        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Metadata (JSON)</label>
        <textarea
          value={metaText}
          onChange={(e) => setMetaText(e.target.value)}
          rows={5}
          style={{
            width: "100%",
            fontFamily: "monospace",
            fontSize: 12,
            padding: 8,
            margin: "4px 0 12px",
            boxSizing: "border-box",
            resize: "vertical",
          }}
        />

        {status.kind === "error" && (
          <div style={{ color: "#c00", fontSize: 12, marginBottom: 8 }}>{status.message}</div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "6px 12px" }}>
            Cancel
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={status.kind === "creating" || !name.trim()}
            style={{ padding: "6px 12px" }}
          >
            {status.kind === "creating" ? "Creating..." : "Create Session"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default NewSessionModal;
