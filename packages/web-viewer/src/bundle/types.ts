/**
 * Minimal type echoes of @agentgit/core for the rows we read out of bundles.
 * Kept in sync manually — bundles carry a `schemaVersion` field so version
 * skew is caught at unpack time.
 */

export interface Author {
  name: string;
  email: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: unknown | null;
  startedAt: number;
  completedAt: number | null;
  status: "pending" | "success" | "error";
  error: string | null;
}

export interface Commit {
  hash: string;
  type: "commit";
  tree: string;
  parent: string | null;
  sessionId: string;
  timestamp: number;
  message: string;
  toolCall: ToolCall | null;
  metadata: Record<string, unknown>;
  author: Author | null;
  signature: string | null;
  publicKey: string | null;
}

export interface TreeEntry {
  path: string;
  blobHash: string;
  size: number;
}

export interface Session {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  head: string | null;
  status: "active" | "completed" | "failed" | "abandoned";
  metadata: Record<string, unknown>;
}

export interface Ref {
  name: string;
  target: string;
  type: "branch" | "tag" | "session-head";
  updatedAt: number;
}

export interface BundleManifest {
  formatVersion: number;
  schemaVersion: number;
  sessionIds: string[];
  createdAt: number;
  generator: string;
}

export const BUNDLE_FORMAT_VERSION = 1;

/**
 * The web viewer is forward-compatible with bundles produced by any
 * agentgit ≤ this schemaVersion. Bumping this means the viewer has been
 * audited against the new SQLite schema.
 */
export const VIEWER_SCHEMA_VERSION = 2;
