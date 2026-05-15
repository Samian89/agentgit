import React, { useEffect, useState } from "react";
import { readConfig, writeConfig } from "../ipc.js";

export interface SettingsPanelProps {
  dbPath: string;
  onSaved?: () => void;
}

/**
 * Settings panel for .agentgit/config.json.
 * Covers identity (user.*), signing, and guard configuration introduced by
 * AMC-264f6e13. Changes are persisted to disk and picked up by new wrapped
 * agents without UI restart.
 */
export function SettingsPanel({ dbPath, onSaved }: SettingsPanelProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form fields (flattened for UI, nested on save)
  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [signingEnabled, setSigningEnabled] = useState(false);
  const [signingKeyPath, setSigningKeyPath] = useState("");
  const [guardsEnabled, setGuardsEnabled] = useState(true);
  const [confirmationAllowlist, setConfirmationAllowlist] = useState("[]");
  const [confirmationDenylist, setConfirmationDenylist] = useState("[]");
  const [confirmationAutoConfirm, setConfirmationAutoConfirm] = useState("[]");
  const [snapshotEnabled, setSnapshotEnabled] = useState(true);
  const [maxBlobBytes, setMaxBlobBytes] = useState("1048576");

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const cfg = (await readConfig(dbPath)) as Record<string, unknown>;
        if (!mounted) return;

        const user = (cfg.user as Record<string, string>) || {};
        setUserName(user.name || "");
        setUserEmail(user.email || "");

        const signing = (cfg.signing as Record<string, unknown>) || {};
        setSigningEnabled(signing.enabled !== false);
        setSigningKeyPath((signing.keyPath as string) || "");

        const guards = (cfg.guards as Record<string, unknown>) || {};
        setGuardsEnabled(guards.enabled !== false);

        const conf = (guards.confirmation as Record<string, unknown>) || {};
        setConfirmationAllowlist(JSON.stringify(conf.allowlist || [], null, 0));
        setConfirmationDenylist(JSON.stringify(conf.denylist || [], null, 0));
        setConfirmationAutoConfirm(JSON.stringify(conf.autoConfirm || [], null, 0));

        const snap = (guards.snapshot as Record<string, unknown>) || {};
        setSnapshotEnabled(snap.enabled !== false);
        setMaxBlobBytes(String(snap.maxBlobBytes ?? 1048576));
      } catch (e) {
        if (mounted) setErr(String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [dbPath]);

  const handleSave = async () => {
    setSaving(true);
    setErr(null);
    setSuccess(null);

    let allow: unknown[] = [];
    let deny: unknown[] = [];
    let autoC: unknown[] = [];
    try {
      allow = confirmationAllowlist.trim() ? JSON.parse(confirmationAllowlist) : [];
      deny = confirmationDenylist.trim() ? JSON.parse(confirmationDenylist) : [];
      autoC = confirmationAutoConfirm.trim() ? JSON.parse(confirmationAutoConfirm) : [];
    } catch (e) {
      setErr("Invalid JSON array in confirmation lists");
      setSaving(false);
      return;
    }

    const maxBytes = parseInt(maxBlobBytes, 10) || 1048576;

    const newConfig: Record<string, unknown> = {
      user: userName && userEmail ? { name: userName.trim(), email: userEmail.trim() } : undefined,
      signing: {
        enabled: signingEnabled,
        ...(signingKeyPath ? { keyPath: signingKeyPath.trim() } : {}),
      },
      guards: {
        enabled: guardsEnabled,
        confirmation: {
          allowlist: allow,
          denylist: deny,
          autoConfirm: autoC,
        },
        snapshot: {
          enabled: snapshotEnabled,
          maxBlobBytes: maxBytes,
        },
      },
    };

    // Remove undefined user
    if (!newConfig.user) delete newConfig.user;

    try {
      await writeConfig(dbPath, newConfig);
      setSuccess("Settings saved. New agents will use updated guards.");
      onSaved?.();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 16 }}>Loading config…</div>;
  }

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
        Edits .agentgit/config.json. Guard changes take effect for newly wrapped agents immediately.
      </p>

      {err && <div style={{ color: "#c00", margin: "8px 0" }}>{err}</div>}
      {success && <div style={{ color: "#070", margin: "8px 0" }}>{success}</div>}

      <fieldset style={{ border: "1px solid var(--border)", padding: 12, marginBottom: 16 }}>
        <legend>User Identity</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <label style={{ fontSize: 12 }}>Name</label>
            <input
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="Ada Lovelace"
              style={{ width: "100%", padding: 6 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12 }}>Email</label>
            <input
              value={userEmail}
              onChange={(e) => setUserEmail(e.target.value)}
              placeholder="ada@example.com"
              style={{ width: "100%", padding: 6 }}
            />
          </div>
        </div>
      </fieldset>

      <fieldset style={{ border: "1px solid var(--border)", padding: 12, marginBottom: 16 }}>
        <legend>Signing</legend>
        <label style={{ display: "block", marginBottom: 6 }}>
          <input
            type="checkbox"
            checked={signingEnabled}
            onChange={(e) => setSigningEnabled(e.target.checked)}
          />{" "}
          Enable commit signing
        </label>
        <label style={{ fontSize: 12, display: "block" }}>Key path (optional)</label>
        <input
          value={signingKeyPath}
          onChange={(e) => setSigningKeyPath(e.target.value)}
          placeholder="~/.ssh/id_ed25519"
          style={{ width: "100%", padding: 6 }}
        />
      </fieldset>

      <fieldset style={{ border: "1px solid var(--border)", padding: 12, marginBottom: 16 }}>
        <legend>Guards (from AMC-264f6e13)</legend>
        <label style={{ display: "block", marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={guardsEnabled}
            onChange={(e) => setGuardsEnabled(e.target.checked)}
          />{" "}
          Guards enabled (default on)
        </label>

        <div style={{ marginLeft: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 13, margin: "8px 0 4px" }}>Confirmation</div>
          <label style={{ fontSize: 11 }}>Allowlist (JSON array)</label>
          <input
            value={confirmationAllowlist}
            onChange={(e) => setConfirmationAllowlist(e.target.value)}
            style={{ width: "100%", fontFamily: "monospace", fontSize: 12, padding: 4 }}
          />
          <label style={{ fontSize: 11 }}>Denylist (JSON array)</label>
          <input
            value={confirmationDenylist}
            onChange={(e) => setConfirmationDenylist(e.target.value)}
            style={{ width: "100%", fontFamily: "monospace", fontSize: 12, padding: 4 }}
          />
          <label style={{ fontSize: 11 }}>Auto-confirm (JSON array)</label>
          <input
            value={confirmationAutoConfirm}
            onChange={(e) => setConfirmationAutoConfirm(e.target.value)}
            style={{ width: "100%", fontFamily: "monospace", fontSize: 12, padding: 4 }}
          />

          <div style={{ fontWeight: 600, fontSize: 13, margin: "12px 0 4px" }}>Snapshot</div>
          <label style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={snapshotEnabled}
              onChange={(e) => setSnapshotEnabled(e.target.checked)}
            />{" "}
            Snapshot enabled
          </label>
          <label style={{ fontSize: 11 }}>Max blob bytes</label>
          <input
            type="number"
            value={maxBlobBytes}
            onChange={(e) => setMaxBlobBytes(e.target.value)}
            style={{ width: 140, padding: 4 }}
          />
        </div>
      </fieldset>

      <button onClick={() => void handleSave()} disabled={saving} style={{ padding: "8px 16px" }}>
        {saving ? "Saving..." : "Save Settings"}
      </button>
      <button onClick={() => window.location.reload()} style={{ marginLeft: 8, padding: "8px 16px" }}>
        Reload UI
      </button>
    </div>
  );
}

export default SettingsPanel;
