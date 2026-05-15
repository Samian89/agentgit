import React, { useState } from "react";
import { abandonSession } from "../ipc.js";
import type { SessionRow } from "../types.js";

export interface AbandonSessionModalProps {
  dbPath: string;
  session: SessionRow;
  onClose: () => void;
  onAbandoned?: (sessionId: string) => void;
}

/**
 * Confirmation modal for abandoning a session. Requires the user to type
 * the exact session name before the Abandon button is enabled.
 */
export function AbandonSessionModal({
  dbPath,
  session,
  onClose,
  onAbandoned,
}: AbandonSessionModalProps) {
  const [confirmText, setConfirmText] = useState("");
  const [status, setStatus] = useState<"idle" | "abandoning" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  const isMatch = confirmText.trim() === session.name;
  const canAbandon = isMatch && status !== "abandoning";

  const handleAbandon = async () => {
    if (!isMatch) return;
    setStatus("abandoning");
    setErr(null);
    try {
      await abandonSession(dbPath, session.id);
      onAbandoned?.(session.id);
      onClose();
    } catch (e) {
      setErr(String(e));
      setStatus("error");
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
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
          border: "1px solid #c33",
          borderRadius: 8,
          padding: 20,
          width: "min(440px, 92vw)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0, color: "#900" }}>Abandon Session</h3>
        <p style={{ fontSize: 13, lineHeight: 1.4 }}>
          This will mark the session <strong>{session.name}</strong> as <strong>abandoned</strong>.
          It will no longer appear in the default list. This action cannot be undone from the UI.
        </p>

        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Type the session name to confirm:
        </label>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={session.name}
          style={{
            width: "100%",
            padding: 8,
            margin: "6px 0 12px",
            border: "1px solid #c33",
            boxSizing: "border-box",
            fontFamily: "monospace",
          }}
          autoFocus
        />

        {err && <div style={{ color: "#c00", fontSize: 12, marginBottom: 8 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "6px 12px" }}>
            Cancel
          </button>
          <button
            onClick={() => void handleAbandon()}
            disabled={!canAbandon}
            style={{
              padding: "6px 12px",
              background: canAbandon ? "#c33" : "#eee",
              color: canAbandon ? "#fff" : "#666",
              border: "none",
              borderRadius: 4,
            }}
          >
            {status === "abandoning" ? "Abandoning..." : "Abandon Session"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AbandonSessionModal;
