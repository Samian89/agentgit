export interface SessionRow {
  id: string;
  name: string;
  status: string;
  head: string | null;
  created_at: number;
  updated_at: number;
  metadata: string;
}

export interface CommitRow {
  hash: string;
  tree: string;
  parent: string | null;
  session_id: string;
  timestamp: number;
  message: string;
  tool_call: string | null;
  metadata: string;
}

export interface DiffEntry {
  path: string;
  from_hash: string | null;
  to_hash: string | null;
}

export interface DiffResult {
  hash1: string;
  hash2: string;
  commit1_tool_call: string | null;
  commit2_tool_call: string | null;
  added: DiffEntry[];
  removed: DiffEntry[];
  modified: DiffEntry[];
}

export interface BlameEntry {
  path: string;
  commit_hash: string;
  timestamp: number;
  message: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: unknown | null;
  started_at: number;
  completed_at: number | null;
  status: "pending" | "success" | "error";
  error: string | null;
}
