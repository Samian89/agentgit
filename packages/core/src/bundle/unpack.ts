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
  // the objects/ entries (a row whose body hashes to the same value).
  for (const commit of commits) {
    const recomputed = sha256(commit as unknown as Record<string, unknown>);
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
  }

  for (const ref of refs) {
    if (!commitsByHash.has(ref.target)) {
      throw new Error(
        `Bundle: ref ${ref.name} targets missing commit ${ref.target}`,
      );
    }
  }

  for (const session of sessions) {
    if (session.head !== null && !commitsByHash.has(session.head)) {
      throw new Error(
        `Bundle: session ${session.id} head ${session.head} is missing from commits.jsonl`,
      );
    }
  }

  return { manifest, objects, commits, refs, sessions };
}
