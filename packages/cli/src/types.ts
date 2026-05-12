import type { ToolCall } from "@agentgit/core";

export interface ReplayStateEntry {
  path: string;
  blobHash: string;
  size: number;
}

export interface ReplayCommit {
  hash: string;
  timestamp: number;
  message: string;
  toolCall: ToolCall | null;
  stateSnapshot: ReplayStateEntry[];
}

export interface ReplayExport {
  version: "1";
  sessionId: string;
  sessionName: string;
  exportedAt: number;
  commits: ReplayCommit[];
}
