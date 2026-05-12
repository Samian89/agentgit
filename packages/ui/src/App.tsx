import React, { useCallback, useEffect, useState } from "react";
import BlameView from "./components/BlameView.js";
import DiffView from "./components/DiffView.js";
import StepCard from "./components/StepCard.js";
import TimelineScrollbar from "./components/TimelineScrollbar.js";
import { getBlame, getCommits, getDiff, getSessions } from "./ipc.js";
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

  const loadSessions = useCallback(async () => {
    try {
      setError(null);
      const rows = await getSessions(dbPath);
      setSessions(rows);
      if (rows.length > 0 && !selectedSession) {
        setSelectedSession(rows[0]?.id ?? null);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [dbPath, selectedSession]);

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
          onBlur={() => void loadSessions()}
        />
        <button onClick={() => void loadSessions()}>Load</button>
        {sessions.length > 0 && (
          <select
            value={selectedSession ?? ""}
            onChange={(e) => setSelectedSession(e.target.value)}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.status})
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <div className="error-banner">{error}</div>}
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
    </>
  );
}
