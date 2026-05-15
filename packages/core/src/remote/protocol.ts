import type { Hash, RefType } from "../types.js";

/**
 * Request/response shapes for the AgentGit Remote Protocol v1.
 * See docs/remote-protocol.md for the full contract.
 *
 * @public
 */

/** Current major version of the wire protocol. Sent as `AgentGit-Protocol`. */
export const REMOTE_PROTOCOL_VERSION = 1;

/** URL prefix for v1 endpoints. */
export const REMOTE_PROTOCOL_PREFIX = "/api/v1";

// ---------------------------------------------------------------------------
// refs/list
// ---------------------------------------------------------------------------

export interface RefsListRequest {
  // Reserved for future filters (e.g. prefix). Empty object today.
}

export interface RemoteRef {
  name: string;
  target: Hash;
  type: RefType;
}

export interface RefsListResponse {
  refs: RemoteRef[];
}

// ---------------------------------------------------------------------------
// objects/missing
// ---------------------------------------------------------------------------

export interface ObjectsMissingRequest {
  /** Hashes the client wants to push (any object type). */
  wants: Hash[];
  /** Hashes the client believes the server already has. */
  haves: Hash[];
}

export interface ObjectsMissingResponse {
  /** Subset of `wants` that the server does not have. */
  missing: Hash[];
}

// ---------------------------------------------------------------------------
// objects/upload
// ---------------------------------------------------------------------------

export interface UploadLine {
  hash: Hash;
  body: Record<string, unknown>;
}

export interface ObjectsUploadResponse {
  uploadId: string;
  /** Cumulative set of hashes durably received for this upload id. */
  received: Hash[];
  /** Hashes that failed validation in this request. */
  rejected: Array<{ hash: Hash; reason: string }>;
  /** Set when the upload has been committed and pending state cleared. */
  committed?: boolean;
}

// ---------------------------------------------------------------------------
// objects/download
// ---------------------------------------------------------------------------

export interface ObjectsDownloadRequest {
  hashes: Hash[];
}

// Response is NDJSON: one UploadLine per row. See RemoteClient.downloadObjects.

// ---------------------------------------------------------------------------
// refs/update
// ---------------------------------------------------------------------------

export interface RefsUpdateRequest {
  name: string;
  type: RefType;
  /** Expected current target, or null when creating the ref. */
  old: Hash | null;
  /** New target hash. Must already exist on the server. */
  new: Hash;
}

export type RefsUpdateResponse =
  | { ok: true }
  | { ok: false; error: "ref-conflict"; current: Hash | null }
  | { ok: false; error: "missing-target" };

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export interface RemoteError {
  error: string;
  message?: string;
}

/** Thrown by RemoteClient when an HTTP request fails non-recoverably. */
export class RemoteProtocolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "RemoteProtocolError";
  }
}
