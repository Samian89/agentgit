import { invoke } from "@tauri-apps/api/core";
import type { BlameEntry, CommitRow, DiffResult, SessionRow } from "./types.js";

export const getSessions = (dbPath: string): Promise<SessionRow[]> =>
  invoke("get_sessions", { dbPath });

export const getCommits = (dbPath: string, sessionId: string): Promise<CommitRow[]> =>
  invoke("get_commits", { dbPath, sessionId });

export const getDiff = (dbPath: string, hash1: string, hash2: string): Promise<DiffResult> =>
  invoke("get_diff", { dbPath, hash1, hash2 });

export const getBlame = (dbPath: string, sessionId: string): Promise<BlameEntry[]> =>
  invoke("get_blame", { dbPath, sessionId });

// -----------------------------------------------------------------------------
// Remote sync (spec 005)
// -----------------------------------------------------------------------------

export interface RemoteRecord {
  name: string;
  url: string;
  token?: string;
}

export interface PushSessionResult {
  ok: boolean;
  remote: string;
  sessionId: string;
  shareUrl: string;
  output: string;
}

export const listRemotes = (dbPath: string): Promise<RemoteRecord[]> =>
  invoke("list_remotes", { dbPath });

export const addRemote = (
  dbPath: string,
  name: string,
  url: string,
  token?: string,
): Promise<RemoteRecord> =>
  invoke("add_remote", {
    dbPath,
    name,
    url,
    token: token ?? null,
  });

export const pushSession = (
  dbPath: string,
  remoteName: string,
  sessionId: string,
): Promise<PushSessionResult> =>
  invoke("push_session", { dbPath, remoteName, sessionId });

// -----------------------------------------------------------------------------
// Write-side features (AMC-f3602678): new session, replay, bundle export,
// abandon, and config read/write for Settings + guards.
// -----------------------------------------------------------------------------

export interface BundleExportResult {
  bundlePath: string;
}

export const createSession = (
  dbPath: string,
  name: string,
  metadata: Record<string, unknown> = {},
): Promise<SessionRow> =>
  invoke("create_session", { dbPath, name, metadata });

export const replayFromCommit = (
  dbPath: string,
  commitHash: string,
  newSessionName: string,
): Promise<SessionRow> =>
  invoke("replay_from_commit", { dbPath, commitHash, newSessionName });

export const exportBundle = (
  dbPath: string,
  sessionId: string,
  outPath: string,
): Promise<BundleExportResult> =>
  invoke("export_bundle", { dbPath, sessionId, outPath });

export const abandonSession = (dbPath: string, sessionId: string): Promise<void> =>
  invoke("abandon_session", { dbPath, sessionId });

export const readConfig = (dbPath: string): Promise<Record<string, unknown>> =>
  invoke("read_config", { dbPath });

export const writeConfig = (
  dbPath: string,
  config: Record<string, unknown>,
): Promise<void> =>
  invoke("write_config", { dbPath, config });
