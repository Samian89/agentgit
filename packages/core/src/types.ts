/**
 * AgentGit Core Data Model
 *
 * Content-Addressing Algorithm:
 *   Objects are identified by the SHA-256 hash of their canonical JSON representation.
 *   Canonical JSON: keys sorted lexicographically at every level, no extra whitespace,
 *   UTF-8 encoded. The "type" field is always included and sorted first only by natural
 *   alphabetical order (no special treatment). To compute a hash:
 *     1. Construct the object as a plain JS value (omitting the `hash` field itself).
 *     2. JSON.stringify with a key-sorting replacer.
 *     3. SHA-256 the resulting UTF-8 bytes.
 *     4. Hex-encode the digest → 64-character lowercase string.
 *   This guarantees identical content always produces the same address regardless of
 *   insertion order, matching git's content-addressed object model.
 *
 * Directory layout (.agentgit/):
 *   HEAD          — plain text; "ref: refs/sessions/<sessionId>" or a bare commit hash
 *   refs/         — subdirectory; each file is a ref name containing a commit hash
 *   objects/      — content-addressed object files; sharded as objects/<2-char prefix>/<62-char suffix>
 *   index.db      — SQLite metadata index (see schema.sql)
 */

// ---------------------------------------------------------------------------
// Primitive aliases
// ---------------------------------------------------------------------------

/** SHA-256 hex digest (64 lowercase hex characters). */
export type Hash = string;

/** ISO-8601 timestamp string or Unix epoch milliseconds. */
export type Timestamp = number;

// ---------------------------------------------------------------------------
// Blob — raw content unit
// ---------------------------------------------------------------------------

export interface Blob {
  /** Content-addressed SHA-256 hash of the canonical form of this object. */
  hash: Hash;
  /** Object type discriminator. */
  type: "blob";
  /** Raw content encoded as a base64 string (allows binary and text). */
  content: string;
  /** Byte length of the original (pre-base64) content. */
  size: number;
  /** Encoding used for `content` field storage. */
  encoding: "base64" | "utf-8";
  /** Original MIME type hint, if known (e.g. "text/plain", "application/json"). */
  mimeType: string | null;
}

// ---------------------------------------------------------------------------
// Tree — directory snapshot of agent state
// ---------------------------------------------------------------------------

export interface TreeEntry {
  /** Logical path within the agent's state namespace (e.g. "files/main.py"). */
  path: string;
  /** Hash of the Blob object at this path. */
  blobHash: Hash;
  /** Byte size of the blob (denormalized for fast listing). */
  size: number;
}

export interface Tree {
  hash: Hash;
  type: "tree";
  entries: TreeEntry[];
}

// ---------------------------------------------------------------------------
// ToolCall — a single agent tool invocation
// ---------------------------------------------------------------------------

export type ToolCallStatus = "pending" | "success" | "error";

export interface ToolCall {
  /** Unique identifier for this invocation (UUID v4 recommended). */
  id: string;
  /** Tool name as registered in the agent framework (e.g. "read_file"). */
  name: string;
  /** Structured input arguments passed to the tool. */
  input: Record<string, unknown>;
  /** Structured output returned by the tool; null if pending or errored. */
  output: unknown | null;
  /** Unix epoch ms when the tool call was initiated. */
  startedAt: Timestamp;
  /** Unix epoch ms when the tool call completed; null if still pending. */
  completedAt: Timestamp | null;
  /** Execution status. */
  status: ToolCallStatus;
  /** Error message if status is "error". */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Commit — single agent step / action record
// ---------------------------------------------------------------------------

/** Committer identity recorded on each commit (from .agentgit/config.json). */
export interface Author {
  name: string;
  email: string;
}

export interface Commit {
  hash: Hash;
  type: "commit";
  /** Hash of the Tree snapshot representing agent state after this step. */
  tree: Hash;
  /** Hash of the parent Commit, or null for the initial commit in a session. */
  parent: Hash | null;
  /** Session this commit belongs to. */
  sessionId: string;
  /** Unix epoch ms when this commit was recorded. */
  timestamp: Timestamp;
  /** Human-readable summary of the step (tool name + short description). */
  message: string;
  /** The tool call that produced this commit; null for manual/synthetic commits. */
  toolCall: ToolCall | null;
  /** Arbitrary key-value metadata (agent version, model, environment, etc.). */
  metadata: Record<string, unknown>;
  /** Committer identity; null when no identity is configured. */
  author: Author | null;
  /** Base64 Ed25519 signature of `hash`; null when commit is unsigned. */
  signature: string | null;
  /** Base64 Ed25519 public key matching `signature`; null when unsigned. */
  publicKey: string | null;
}

// ---------------------------------------------------------------------------
// Ref — named pointer to a commit
// ---------------------------------------------------------------------------

export type RefType = "branch" | "tag" | "session-head";

export interface Ref {
  /** Ref name (e.g. "main", "v1.0.0", "sessions/abc123"). */
  name: string;
  /** Commit hash this ref points to. */
  target: Hash;
  /** Semantic type of the ref. */
  type: RefType;
  /** Unix epoch ms of last update. */
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Session — a complete agent run
// ---------------------------------------------------------------------------

export type SessionStatus = "active" | "completed" | "failed" | "abandoned";

export interface Session {
  /** UUID identifying this session. */
  id: string;
  /** Human-readable name (e.g. "fix-login-bug-2026-05-11"). */
  name: string;
  /** Unix epoch ms when the session was created. */
  createdAt: Timestamp;
  /** Unix epoch ms of the last mutation. */
  updatedAt: Timestamp;
  /** Hash of the most recent commit in this session; null if no commits yet. */
  head: Hash | null;
  /** Lifecycle status of the session. */
  status: SessionStatus;
  /** Arbitrary metadata (agent type, user, environment). */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// StepDiff — difference between two commits
// ---------------------------------------------------------------------------

export interface DiffEntry {
  /** Logical path within the agent state namespace. */
  path: string;
  /** Blob hash before the change; null for added paths. */
  fromHash: Hash | null;
  /** Blob hash after the change; null for removed paths. */
  toHash: Hash | null;
  /** Byte size delta (toSize - fromSize); null when either side is absent. */
  sizeDelta: number | null;
}

export interface StepDiff {
  /** Commit hash of the earlier (base) state. */
  fromHash: Hash;
  /** Commit hash of the later (target) state. */
  toHash: Hash;
  /** Paths present in toHash but not in fromHash. */
  added: DiffEntry[];
  /** Paths present in fromHash but not in toHash. */
  removed: DiffEntry[];
  /** Paths present in both but with different blob hashes. */
  modified: DiffEntry[];
}
