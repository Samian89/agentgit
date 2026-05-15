import React, { useCallback, useEffect, useState } from "react";
import BlameView from "./components/BlameView.js";
import DiffView from "./components/DiffView.js";
import StepCard from "./components/StepCard.js";
import TimelineScrollbar from "./components/TimelineScrollbar.js";
import { NewSessionModal } from "./components/NewSessionModal.js";
import { AbandonSessionModal } from "./components/AbandonSessionModal.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import {
  getBlame,
  getCommits,
  getDiff,
  getSessions,
  createSession,
  replayFromCommit,
  exportBundle,
  abandonSession,
} from "./ipc.js";
import type { BlameEntry, CommitRow, DiffResult, SessionRow } from "./types.js";

export default function App() {
  const [dbPath, setDbPath] = useState(".agentgit/index.db");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitRow[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [compareHash, setCompareHash] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [blame, setBlame] = useState<BlameEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Write-side UI state (AMC-f3602678)
  const [view, setView] = useState<"main" | "settings">("main");
  const [showAbandoned, setShowAbandoned] = useState(false);
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [abandonModalOpen, setAbandonModalOpen] = useState(false);
  const [abandonTarget, setAbandonTarget] = useState<SessionRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Helpers for write actions (defined early to avoid TDZ with loadSessions)
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4200);
  };

  const refreshSessions = useCallback(
    async (selectId?: string) => {
      try {
        setError(null);
        const rows = await getSessions(dbPath);
        setSessions(rows);
        if (selectId) {
          setSelectedSession(selectId);
        } else if (rows.length > 0 && !selectedSession) {
          const firstActive = rows.find((r) => r.status !== "abandoned") ?? rows[0];
          setSelectedSession(firstActive.id);
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [dbPath, selectedSession]
  );

  const handleSessionCreated = (row: SessionRow) => {
    void refreshSessions(row.id);
    showToast(`Created session "${row.name}"`);
  };

  const handleReplay = async (commit: CommitRow) => {
    const suggested = `replay-${commit.hash.slice(0, 6)}`;
    const name = window.prompt("New session name for replay:", suggested);
    if (!name || !name.trim()) return;
    try {
      setError(null);
      const newRow = await replayFromCommit(dbPath, commit.hash, name.trim());
      await refreshSessions(newRow.id);
      showToast(`Replayed from ${commit.hash.slice(0, 8)} into "${newRow.name}"`);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleExportBundle = async (commit: CommitRow) => {
    const sess = sessions.find((s) => s.id === selectedSession);
    const base = (sess?.name || "session").replace(/[^a-z0-9_-]/gi, "_");
    const defaultPath = `${base}.agentgit-bundle`;
    const outPath = window.prompt("Output path for .agentgit-bundle:", defaultPath);
    if (!outPath || !outPath.trim()) return;
    try {
      setError(null);
      const res = await exportBundle(dbPath, selectedSession!, outPath.trim());
      showToast(`Exported bundle to ${res.bundlePath}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const openAbandon = () => {
    const sess = sessions.find((s) => s.id === selectedSession);
    if (sess) {
      setAbandonTarget(sess);
      setAbandonModalOpen(true);
    }
  };

  const handleAbandoned = (id: string) => {
    if (selectedSession === id) {
      const next = sessions.find((s) => s.id !== id && s.status !== "abandoned");
      setSelectedSession(next ? next.id : null);
    }
    void refreshSessions();
    showToast("Session abandoned");
  };

  // legacy thin wrapper so existing useEffects continue to work
  const loadSessions = useCallback(async () => {
    await refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!selectedSession) return;
    void (async () => {
      try {
        setError(null);
        const rows = await getCommits(dbPath, selectedSession);
        setCommits(rows);
        setSelectedHash(rows.at(-1)?.hash ?? null);
        setCompareHash(null);
        setDiff(null);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [dbPath, selectedSession]);

  useEffect(() => {
    if (!selectedSession) return;
    void (async () => {
      try {
        const entries = await getBlame(dbPath, selectedSession);
        setBlame(entries);
      } catch {
        setBlame([]);
      }
    })();
  }, [dbPath, selectedSession]);

  useEffect(() => {
    if (!compareHash || !selectedHash) { setDiff(null); return; }
    void (async () => {
      try {
        const result = await getDiff(dbPath, compareHash, selectedHash);
        setDiff(result);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [dbPath, selectedHash, compareHash]);

  const selectedCommit = commits.find((c) => c.hash === selectedHash) ?? null;

  return (
    <>
      <div className="toolbar">
        <label>DB:</label>
        <input
          type="text"
          value={dbPath}
          onChange={(e) => setDbPath(e.target.value)}
          onBlur={() => void refreshSessions()}
        />
        <button onClick={() => void refreshSessions()}>Load</button>

        <button onClick={() => setNewModalOpen(true)} style={{ marginLeft: 8 }}>
          New Session
        </button>

        <label style={{ marginLeft: 12, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={showAbandoned}
            onChange={(e) => setShowAbandoned(e.target.checked)}
          />{" "}
          Show abandoned
        </label>

        {sessions.length > 0 && (
          <>
            <select
              value={selectedSession ?? ""}
              onChange={(e) => setSelectedSession(e.target.value)}
              style={{ marginLeft: 8 }}
            >
              {sessions
                .filter((s) => showAbandoned || s.status !== "abandoned")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.status})
                  </option>
                ))}
            </select>
            {selectedSession && (
              <button
                onClick={openAbandon}
                title="Abandon selected session"
                style={{ marginLeft: 4 }}
              >
                …
              </button>
            )}
          </>
        )}

        <span style={{ marginLeft: 16, fontSize: 13 }}>
          <button onClick={() => setView("main")} disabled={view === "main"}>
            Main
          </button>
          <button onClick={() => setView("settings")} disabled={view === "settings"}>
            Settings
          </button>
        </span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {toast && <div className="toast-banner" style={{ background: "#0a0", color: "#fff", padding: "4px 12px", fontSize: 13 }}>{toast}</div>}

      {view === "settings" ? (
        <SettingsPanel dbPath={dbPath} onSaved={() => showToast("Config saved")} />
      ) : (
        <div className="main-layout">
          <div className="left-panel">
            <div className="panel-header">Commits ({commits.length})</div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {commits.length === 0 ? (
                <div className="empty-state">No commits. Load a session.</div>
              ) : (
                commits.map((c) => (
                  <StepCard
                    key={c.hash}
                    commit={c}
                    selected={c.hash === selectedHash}
                    onSelect={() => setSelectedHash(c.hash)}
                    onReplay={handleReplay}
                    onExportBundle={handleExportBundle}
                  />
                ))
              )}
            </div>
          </div>
          <div className="right-panel">
            <TimelineScrollbar
              commits={commits}
              selectedHash={selectedHash}
              compareHash={compareHash}
              onSelect={setSelectedHash}
              onCompare={setCompareHash}
            />
            <div className="bottom-panels">
              <div className="diff-panel">
                <div className="panel-header">Diff</div>
                <DiffView diff={diff} selectedCommit={selectedCommit} />
              </div>
              <div className="blame-panel">
                <div className="panel-header">Blame</div>
                <BlameView entries={blame} />
              </div>
            </div>
          </div>
        </div>
      )}

      {newModalOpen && (
        <NewSessionModal
          dbPath={dbPath}
          onClose={() => setNewModalOpen(false)}
          onCreated={handleSessionCreated}
        />
      )}
      {abandonModalOpen && abandonTarget && (
        <AbandonSessionModal
          dbPath={dbPath}
          session={abandonTarget}
          onClose={() => {
            setAbandonModalOpen(false);
            setAbandonTarget(null);
          }}
          onAbandoned={handleAbandoned}
        />
      )}
    </>
  );
}
