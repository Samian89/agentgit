import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BlameView,
  DiffView,
  StepCard,
  TimelineScrollbar,
  type BlameEntry,
  type CommitRow,
  type DiffResult,
  type SessionRow,
} from "@agentgit/ui-components";
import { readBundle, type BundleContents } from "./bundle/unpack.js";
import { InMemoryIndex } from "./in-memory-index.js";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading"; source: string }
  | { kind: "ready"; source: string; index: InMemoryIndex; bundle: BundleContents }
  | { kind: "error"; source: string; message: string };

async function loadFromBytes(
  bytes: Uint8Array,
  source: string,
): Promise<LoadState> {
  try {
    const bundle = await readBundle(bytes);
    return {
      kind: "ready",
      source,
      bundle,
      index: new InMemoryIndex(bundle),
    };
  } catch (e) {
    return { kind: "error", source, message: (e as Error).message };
  }
}

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [dragActive, setDragActive] = useState(false);

  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [compareHash, setCompareHash] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setState({ kind: "loading", source: file.name });
    const buf = new Uint8Array(await file.arrayBuffer());
    setState(await loadFromBytes(buf, file.name));
  }, []);

  // Auto-load ?bundle=<url> if present.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get("bundle");
    if (!url) return;
    setState({ kind: "loading", source: url });
    void (async () => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        setState(await loadFromBytes(buf, url));
      } catch (e) {
        setState({ kind: "error", source: url, message: (e as Error).message });
      }
    })();
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer.files[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  }, []);

  const onDragLeave = useCallback(() => setDragActive(false), []);

  const sessions: SessionRow[] = useMemo(
    () => (state.kind === "ready" ? state.index.getSessions() : []),
    [state],
  );

  // Default selected session to first available on load.
  useEffect(() => {
    if (state.kind === "ready" && sessions.length > 0 && !selectedSession) {
      setSelectedSession(sessions[0]!.id);
    }
  }, [state, sessions, selectedSession]);

  const commits: CommitRow[] = useMemo(() => {
    if (state.kind !== "ready" || !selectedSession) return [];
    return state.index.getCommits(selectedSession);
  }, [state, selectedSession]);

  // Reset selection when session changes
  useEffect(() => {
    setSelectedHash(commits.at(-1)?.hash ?? null);
    setCompareHash(null);
  }, [selectedSession, commits.length]);

  const blame: BlameEntry[] = useMemo(() => {
    if (state.kind !== "ready" || !selectedSession) return [];
    return state.index.getBlame(selectedSession);
  }, [state, selectedSession]);

  const diff: DiffResult | null = useMemo(() => {
    if (state.kind !== "ready" || !selectedHash || !compareHash) return null;
    return state.index.getDiff(compareHash, selectedHash);
  }, [state, selectedHash, compareHash]);

  const selectedCommit = commits.find((c) => c.hash === selectedHash) ?? null;

  if (state.kind === "idle" || state.kind === "loading" || state.kind === "error") {
    return (
      <div
        data-testid="drop-zone"
        className={`drop-zone${dragActive ? " active" : ""}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>AgentGit Web Viewer</h2>
        {state.kind === "idle" && (
          <p>Drop a <code>.agentgit-bundle</code> here, or pass <code>?bundle=&lt;url&gt;</code>.</p>
        )}
        {state.kind === "loading" && <p>Loading {state.source}…</p>}
        {state.kind === "error" && (
          <p style={{ color: "var(--accent)" }}>
            Failed to load {state.source}: {state.message}
          </p>
        )}
        <p style={{ fontSize: 11, opacity: 0.6 }}>Read-only. No data leaves the browser.</p>
      </div>
    );
  }

  return (
    <>
      <div className="toolbar">
        <label>Bundle:</label>
        <span style={{ fontSize: 12 }}>{state.source}</span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>
          format v{state.bundle.manifest.formatVersion}, schema v
          {state.bundle.manifest.schemaVersion}, by {state.bundle.manifest.generator}
        </span>
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
        <button onClick={() => setState({ kind: "idle" })}>Close</button>
      </div>
      <div className="main-layout">
        <div className="left-panel">
          <div className="panel-header">Commits ({commits.length})</div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {commits.length === 0 ? (
              <div className="empty-state">No commits in this session.</div>
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
