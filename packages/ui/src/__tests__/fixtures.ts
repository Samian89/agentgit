import type { BlameEntry, CommitRow, DiffResult, SessionRow } from "../types.js";

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const SESSION_ID = "session-001";

export const FIXTURE_SESSIONS: SessionRow[] = [
  {
    id: SESSION_ID,
    name: "fix-login-bug",
    status: "active",
    head: HASH_B,
    created_at: 1700000000000,
    updated_at: 1700000002000,
    metadata: "{}",
  },
];

export const FIXTURE_COMMITS: CommitRow[] = [
  {
    hash: HASH_A,
    tree: "t" + "a".repeat(63),
    parent: null,
    session_id: SESSION_ID,
    timestamp: 1700000000000,
    message: "read file",
    tool_call: JSON.stringify({
      id: "tc-1",
      name: "read_file",
      input: { path: "/tmp/main.py" },
      output: "print('hello')",
      started_at: 1700000000000,
      completed_at: 1700000000100,
      status: "success",
      error: null,
    }),
    metadata: "{}",
  },
  {
    hash: HASH_B,
    tree: "t" + "b".repeat(63),
    parent: HASH_A,
    session_id: SESSION_ID,
    timestamp: 1700000001000,
    message: "write file",
    tool_call: JSON.stringify({
      id: "tc-2",
      name: "write_file",
      input: { path: "/tmp/main.py", content: "print('world')" },
      output: "ok",
      started_at: 1700000001000,
      completed_at: 1700000001100,
      status: "success",
      error: null,
    }),
    metadata: "{}",
  },
];

export const FIXTURE_DIFF: DiffResult = {
  hash1: HASH_A,
  hash2: HASH_B,
  commit1_tool_call: FIXTURE_COMMITS[0]!.tool_call,
  commit2_tool_call: FIXTURE_COMMITS[1]!.tool_call,
  added: [],
  removed: [],
  modified: [{ path: "files/main.py", from_hash: "f" + "a".repeat(63), to_hash: "f" + "b".repeat(63) }],
};

export const FIXTURE_BLAME: BlameEntry[] = [
  { path: "files/main.py", commit_hash: HASH_B, timestamp: 1700000001000, message: "write file" },
];
