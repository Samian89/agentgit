import { sha256 } from "../hash.js";
import type { Commit, Ref, Session } from "../types.js";
import { readTar } from "./tar.js";
import { BUNDLE_FORMAT_VERSION, type BundleManifest } from "./manifest.js";

export interface UnpackResult {
  manifest: BundleManifest;
  objects: Map<string, Record<string, unknown>>;
  commits: Commit[];
  refs: Ref[];
  sessions: Session[];
}

export interface UnpackOptions {
  /**
   * The client's TARGET_VERSION. Bundles whose schemaVersion exceeds this are
   * refused — they were produced by a newer agentgit and may carry rows the
   * client cannot represent.
   */
  clientSchemaVersion: number;
  /** Defaults to BUNDLE_FORMAT_VERSION; override for tests. */
  clientFormatVersion?: number;
}

const OBJECT_PATH = /^objects\/([0-9a-f]{2})\/([0-9a-f]{62})$/;

function decodeText(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

/**
 * Parse a bundle tarball, verify every object's content hash, and check the
 * manifest's formatVersion and schemaVersion against the client. Throws on
 * any mismatch — callers should treat unpack() as the validation gate before
 * mutating the repo.
 */
export function unpack(tar: Uint8Array, opts: UnpackOptions): UnpackResult {
  const entries = readTar(tar);
  const clientFormat = opts.clientFormatVersion ?? BUNDLE_FORMAT_VERSION;

  let manifest: BundleManifest | null = null;
  let commits: Commit[] = [];
  let refs: Ref[] = [];
  let sessions: Session[] = [];
  const objects = new Map<string, Record<string, unknown>>();

  for (const entry of entries) {
    if (entry.name === "manifest.json") {
      manifest = JSON.parse(decodeText(entry.data)) as BundleManifest;
      continue;
    }
    if (entry.name === "commits.jsonl") {
      commits = decodeText(entry.data)
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Commit);
      continue;
    }
    if (entry.name === "refs.json") {
      refs = JSON.parse(decodeText(entry.data)) as Ref[];
      continue;
    }
    if (entry.name === "sessions.json") {
      sessions = JSON.parse(decodeText(entry.data)) as Session[];
      continue;
    }
    const match = OBJECT_PATH.exec(entry.name);
    if (match) {
      const hash = match[1]! + match[2]!;
      const body = JSON.parse(decodeText(entry.data)) as Record<
        string,
        unknown
      >;
      const recomputed = sha256(body);
      if (recomputed !== hash) {
        throw new Error(
          `Bundle: object ${hash} failed hash verification (computed ${recomputed})`,
        );
      }
      objects.set(hash, body);
      continue;
    }
    // Unknown entries are tolerated — forward-compatibility hook.
  }

  if (!manifest) {
    throw new Error("Bundle: missing manifest.json");
  }
  // Validate manifest fields BEFORE the version comparisons. A malformed
  // manifest (missing fields, wrong types) would otherwise slip past
  // `undefined > 1` checks and appear version-compatible.
  const m = manifest as unknown as Record<string, unknown>;
  if (
    typeof m["formatVersion"] !== "number" ||
    !Number.isInteger(m["formatVersion"]) ||
    m["formatVersion"] < 1
  ) {
    throw new Error(
      "Bundle: manifest.formatVersion must be a positive integer",
    );
  }
  if (
    typeof m["schemaVersion"] !== "number" ||
    !Number.isInteger(m["schemaVersion"]) ||
    m["schemaVersion"] < 1
  ) {
    throw new Error(
      "Bundle: manifest.schemaVersion must be a positive integer",
    );
  }
  if (!Array.isArray(m["sessionIds"])) {
    throw new Error("Bundle: manifest.sessionIds must be an array");
  }
  for (const sid of m["sessionIds"] as unknown[]) {
    if (typeof sid !== "string" || sid === "") {
      throw new Error(
        "Bundle: manifest.sessionIds must contain non-empty strings",
      );
    }
  }
  if (typeof m["createdAt"] !== "number" || !Number.isFinite(m["createdAt"])) {
    throw new Error("Bundle: manifest.createdAt must be a finite number");
  }
  if (typeof m["generator"] !== "string") {
    throw new Error("Bundle: manifest.generator must be a string");
  }

  if (manifest.formatVersion > clientFormat) {
    throw new Error(
      `Bundle: formatVersion ${manifest.formatVersion} is newer than this client (${clientFormat})`,
    );
  }
  if (manifest.schemaVersion > opts.clientSchemaVersion) {
    throw new Error(
      `Bundle: schemaVersion ${manifest.schemaVersion} is newer than this client (${opts.clientSchemaVersion})`,
    );
  }

  // Verify every commit's hash matches the stored body, and is mirrored in
  // the objects/ entries (a row whose body hashes to the same value). Also
  // reject duplicate hashes in commits.jsonl so a bundle can't silently
  // bury a second, conflicting body for the same hash, and validate the
  // row shape so missing required fields surface here instead of as
  // NOT-NULL violations buried inside the SQLite transaction.
  const seenCommitHashes = new Set<string>();
  for (const commit of commits) {
    const c = commit as unknown as Record<string, unknown>;
    if (typeof c["hash"] !== "string") {
      throw new Error("Bundle: commits.jsonl row is missing a string hash");
    }
    if (typeof c["tree"] !== "string") {
      throw new Error(
        `Bundle: commit ${commit.hash} is missing a string tree field`,
      );
    }
    if (typeof c["sessionId"] !== "string") {
      throw new Error(
        `Bundle: commit ${commit.hash} is missing a string sessionId`,
      );
    }
    if (typeof c["timestamp"] !== "number" || !Number.isFinite(c["timestamp"])) {
      throw new Error(
        `Bundle: commit ${commit.hash} has invalid timestamp`,
      );
    }
    if (typeof c["message"] !== "string") {
      throw new Error(
        `Bundle: commit ${commit.hash} is missing a string message`,
      );
    }
    if (commit.parent !== null && typeof commit.parent !== "string") {
      throw new Error(
        `Bundle: commit ${commit.hash} has invalid parent field`,
      );
    }

    if (seenCommitHashes.has(commit.hash)) {
      throw new Error(
        `Bundle: commit ${commit.hash} appears more than once in commits.jsonl`,
      );
    }
    seenCommitHashes.add(commit.hash);

    const recomputed = sha256(c);
    if (recomputed !== commit.hash) {
      throw new Error(
        `Bundle: commit ${commit.hash} failed hash verification (computed ${recomputed})`,
      );
    }
    if (!objects.has(commit.hash)) {
      throw new Error(
        `Bundle: commit ${commit.hash} referenced by commits.jsonl is missing from objects/`,
      );
    }
  }

  // Reachability — every reference *inside* the bundle must resolve to a row
  // we have. This is what stops a bundle from claiming "I contain session X"
  // while omitting the blob/tree/commit X needs. Catching it here means the
  // import phase can never partially succeed; if unpack returns, every later
  // INSERT is guaranteed to find its target row.
  const commitsByHash = new Map(commits.map((c) => [c.hash, c]));

  for (const [hash, body] of objects) {
    if (body["type"] !== "tree") continue;
    const entries = body["entries"];
    if (!Array.isArray(entries)) {
      throw new Error(
        `Bundle: tree ${hash} has a malformed entries field`,
      );
    }
    for (const entry of entries as Array<{
      path?: unknown;
      blobHash?: unknown;
      size?: unknown;
    }>) {
      // Every tree entry must be fully shaped before the SQLite insert runs.
      // Catching malformed entries here keeps `importBundleFile` failure-free
      // once `unpack` returns; no NOT NULL violations buried in the txn.
      const path = entry?.path;
      if (typeof path !== "string" || path.length === 0) {
        throw new Error(
          `Bundle: tree ${hash} has an entry with missing or empty path`,
        );
      }
      const size = entry?.size;
      if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
        throw new Error(
          `Bundle: tree ${hash} entry '${path}' has invalid size`,
        );
      }
      const blobHash = entry?.blobHash;
      if (typeof blobHash !== "string") {
        throw new Error(
          `Bundle: tree ${hash} entry '${path}' is missing blobHash`,
        );
      }
      if (!objects.has(blobHash)) {
        throw new Error(
          `Bundle: tree ${hash} references missing blob ${blobHash}`,
        );
      }
    }
  }

  const sessionIds = new Set(sessions.map((s) => s.id));

  for (const commit of commits) {
    if (!objects.has(commit.tree)) {
      throw new Error(
        `Bundle: commit ${commit.hash} references missing tree ${commit.tree}`,
      );
    }
    if (commit.parent !== null && !commitsByHash.has(commit.parent)) {
      throw new Error(
        `Bundle: commit ${commit.hash} references missing parent ${commit.parent}`,
      );
    }
    // Every commit must belong to a session that ships in this bundle.
    // Closing this here means the SQLite commits.session_id → sessions.id
    // FK can never fire during import — unpack stays the sole gate.
    if (!sessionIds.has(commit.sessionId)) {
      throw new Error(
        `Bundle: commit ${commit.hash} references missing session ${commit.sessionId}`,
      );
    }
  }

  const VALID_REF_TYPES = new Set(["branch", "tag", "session-head"]);
  for (const ref of refs) {
    const r = ref as unknown as Record<string, unknown>;
    if (typeof r["name"] !== "string" || r["name"] === "") {
      throw new Error("Bundle: refs.json row is missing a non-empty name");
    }
    if (typeof r["target"] !== "string") {
      throw new Error(
        `Bundle: ref ${r["name"] as string} has a non-string target`,
      );
    }
    if (!VALID_REF_TYPES.has(r["type"] as string)) {
      throw new Error(
        `Bundle: ref ${ref.name} has invalid type '${r["type"]}'`,
      );
    }
    if (!commitsByHash.has(ref.target)) {
      throw new Error(
        `Bundle: ref ${ref.name} targets missing commit ${ref.target}`,
      );
    }
  }

  const VALID_SESSION_STATUSES = new Set([
    "active",
    "completed",
    "failed",
    "abandoned",
  ]);
  const seenSessionIds = new Set<string>();
  for (const session of sessions) {
    const s = session as unknown as Record<string, unknown>;
    if (typeof s["id"] !== "string" || s["id"] === "") {
      throw new Error("Bundle: sessions.json row is missing a non-empty id");
    }
    if (seenSessionIds.has(session.id)) {
      throw new Error(
        `Bundle: session ${session.id} appears more than once in sessions.json`,
      );
    }
    seenSessionIds.add(session.id);
    if (typeof s["name"] !== "string") {
      throw new Error(
        `Bundle: session ${session.id} is missing a string name`,
      );
    }
    if (!VALID_SESSION_STATUSES.has(s["status"] as string)) {
      throw new Error(
        `Bundle: session ${session.id} has invalid status '${s["status"]}'`,
      );
    }
    if (typeof s["createdAt"] !== "number" || !Number.isFinite(s["createdAt"])) {
      throw new Error(
        `Bundle: session ${session.id} has invalid createdAt`,
      );
    }
    if (typeof s["updatedAt"] !== "number" || !Number.isFinite(s["updatedAt"])) {
      throw new Error(
        `Bundle: session ${session.id} has invalid updatedAt`,
      );
    }
    if (session.head !== null && typeof session.head !== "string") {
      throw new Error(
        `Bundle: session ${session.id} has invalid head field`,
      );
    }
    if (session.head !== null && !commitsByHash.has(session.head)) {
      throw new Error(
        `Bundle: session ${session.id} head ${session.head} is missing from commits.jsonl`,
      );
    }
  }

  // manifest.sessionIds must exactly match the set of session ids in
  // sessions.json. A mismatch indicates a malformed or doctored bundle
  // (e.g. the manifest names a session whose record was dropped from the
  // payload, or sessions.json carries extras the manifest never declared).
  const manifestSessionIds = new Set(manifest.sessionIds);
  for (const declared of manifestSessionIds) {
    if (!seenSessionIds.has(declared)) {
      throw new Error(
        `Bundle: manifest.sessionIds names ${declared} but sessions.json does not contain it`,
      );
    }
  }
  for (const present of seenSessionIds) {
    if (!manifestSessionIds.has(present)) {
      throw new Error(
        `Bundle: sessions.json contains ${present} but manifest.sessionIds does not declare it`,
      );
    }
  }

  return { manifest, objects, commits, refs, sessions };
}
