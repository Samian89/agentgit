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
