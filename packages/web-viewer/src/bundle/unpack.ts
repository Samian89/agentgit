import pako from "pako";
import { readTar } from "./tar.js";
import { sha256 } from "./hash.js";
import {
  BUNDLE_FORMAT_VERSION,
  VIEWER_SCHEMA_VERSION,
  type BundleManifest,
  type Commit,
  type Ref,
  type Session,
} from "./types.js";

export interface BundleContents {
  manifest: BundleManifest;
  objects: Map<string, Record<string, unknown>>;
  commits: Commit[];
  refs: Ref[];
  sessions: Session[];
}

const OBJECT_PATH = /^objects\/([0-9a-f]{2})\/([0-9a-f]{62})$/;

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

/**
 * Read a gzipped `.agentgit-bundle` from raw bytes, verify every object's
 * content hash, and check the manifest's formatVersion / schemaVersion. Any
 * mismatch throws — callers should treat this as an atomic validation step.
 */
export async function readBundle(gz: Uint8Array): Promise<BundleContents> {
  const tar = pako.ungzip(gz);
  const entries = readTar(tar);

  let manifest: BundleManifest | null = null;
  let commits: Commit[] = [];
  let refs: Ref[] = [];
  let sessions: Session[] = [];
  const objects = new Map<string, Record<string, unknown>>();

  for (const entry of entries) {
    if (entry.name === "manifest.json") {
      manifest = JSON.parse(decode(entry.data)) as BundleManifest;
      continue;
    }
    if (entry.name === "commits.jsonl") {
      commits = decode(entry.data)
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Commit);
      continue;
    }
    if (entry.name === "refs.json") {
      refs = JSON.parse(decode(entry.data)) as Ref[];
      continue;
    }
    if (entry.name === "sessions.json") {
      sessions = JSON.parse(decode(entry.data)) as Session[];
      continue;
    }
    const m = OBJECT_PATH.exec(entry.name);
    if (m) {
      const hash = m[1]! + m[2]!;
      const body = JSON.parse(decode(entry.data)) as Record<string, unknown>;
      const recomputed = await sha256(body);
      if (recomputed !== hash) {
        throw new Error(
          `Bundle: object ${hash} failed hash verification (computed ${recomputed})`,
        );
      }
      objects.set(hash, body);
    }
  }

  if (!manifest) throw new Error("Bundle: missing manifest.json");

  const m = manifest as unknown as Record<string, unknown>;
  if (
    typeof m["formatVersion"] !== "number" ||
    !Number.isInteger(m["formatVersion"]) ||
    (m["formatVersion"] as number) < 1
  ) {
    throw new Error(
      "Bundle: manifest.formatVersion must be a positive integer",
    );
  }
  if (
    typeof m["schemaVersion"] !== "number" ||
    !Number.isInteger(m["schemaVersion"]) ||
    (m["schemaVersion"] as number) < 1
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

  if (manifest.formatVersion > BUNDLE_FORMAT_VERSION) {
    throw new Error(
      `Bundle: formatVersion ${manifest.formatVersion} is newer than this viewer (${BUNDLE_FORMAT_VERSION})`,
    );
  }
  if (manifest.schemaVersion > VIEWER_SCHEMA_VERSION) {
    throw new Error(
      `Bundle: schemaVersion ${manifest.schemaVersion} is newer than this viewer (${VIEWER_SCHEMA_VERSION})`,
    );
  }

  const seenCommitHashes = new Set<string>();
  for (const c of commits) {
    const row = c as unknown as Record<string, unknown>;
    if (typeof row["hash"] !== "string") {
      throw new Error("Bundle: commits.jsonl row is missing a string hash");
    }
    if (typeof row["tree"] !== "string") {
      throw new Error(
        `Bundle: commit ${c.hash} is missing a string tree field`,
      );
    }
    if (typeof row["sessionId"] !== "string") {
      throw new Error(
        `Bundle: commit ${c.hash} is missing a string sessionId`,
      );
    }
    if (typeof row["timestamp"] !== "number" || !Number.isFinite(row["timestamp"])) {
      throw new Error(`Bundle: commit ${c.hash} has invalid timestamp`);
    }
    if (typeof row["message"] !== "string") {
      throw new Error(`Bundle: commit ${c.hash} is missing a string message`);
    }
    if (c.parent !== null && typeof c.parent !== "string") {
      throw new Error(`Bundle: commit ${c.hash} has invalid parent field`);
    }
    if (c.llmCall != null && typeof c.llmCall !== "object") {
      throw new Error(`Bundle: commit ${c.hash} has invalid llmCall`);
    }

    if (seenCommitHashes.has(c.hash)) {
      throw new Error(
        `Bundle: commit ${c.hash} appears more than once in commits.jsonl`,
      );
    }
    seenCommitHashes.add(c.hash);

    const recomputed = await sha256(row);
    if (recomputed !== c.hash) {
      throw new Error(
        `Bundle: commit ${c.hash} failed hash verification (computed ${recomputed})`,
      );
    }
    if (!objects.has(c.hash)) {
      throw new Error(
        `Bundle: commit ${c.hash} referenced by commits.jsonl is missing from objects/`,
      );
    }
  }

  // Reachability — every internal reference must resolve inside the bundle.
  // Mirrors packages/core/src/bundle/unpack.ts so a viewer never paints a
  // session with dangling references.
  const commitsByHash = new Map(commits.map((c) => [c.hash, c]));
  const sessionIds = new Set(sessions.map((s) => s.id));

  for (const c of commits) {
    if (!objects.has(c.tree)) {
      throw new Error(
        `Bundle: commit ${c.hash} references missing tree ${c.tree}`,
      );
    }
    if (c.parent !== null && !commitsByHash.has(c.parent)) {
      throw new Error(
        `Bundle: commit ${c.hash} references missing parent ${c.parent}`,
      );
    }
    if (!sessionIds.has(c.sessionId)) {
      throw new Error(
        `Bundle: commit ${c.hash} references missing session ${c.sessionId}`,
      );
    }
  }

  for (const [hash, body] of objects) {
    if (body["type"] !== "tree") continue;
    const entries = body["entries"];
    if (!Array.isArray(entries)) {
      throw new Error(`Bundle: tree ${hash} has a malformed entries field`);
    }
    for (const entry of entries as Array<{
      path?: unknown;
      blobHash?: unknown;
      size?: unknown;
    }>) {
      const path = entry?.path;
      if (typeof path !== "string" || path.length === 0) {
        throw new Error(
          `Bundle: tree ${hash} has an entry with missing or empty path`,
        );
      }
      const size = entry?.size;
      if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
        throw new Error(`Bundle: tree ${hash} entry '${path}' has invalid size`);
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

  const VALID_REF_TYPES = new Set(["branch", "tag", "session-head"]);
  for (const r of refs) {
    const row = r as unknown as Record<string, unknown>;
    if (typeof row["name"] !== "string" || row["name"] === "") {
      throw new Error("Bundle: refs.json row is missing a non-empty name");
    }
    if (typeof row["target"] !== "string") {
      throw new Error(
        `Bundle: ref ${row["name"] as string} has a non-string target`,
      );
    }
    if (!VALID_REF_TYPES.has(row["type"] as string)) {
      throw new Error(
        `Bundle: ref ${r.name} has invalid type '${row["type"]}'`,
      );
    }
    if (!commitsByHash.has(r.target)) {
      throw new Error(
        `Bundle: ref ${r.name} targets missing commit ${r.target}`,
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
  for (const s of sessions) {
    const row = s as unknown as Record<string, unknown>;
    if (typeof row["id"] !== "string" || row["id"] === "") {
      throw new Error("Bundle: sessions.json row is missing a non-empty id");
    }
    if (seenSessionIds.has(s.id)) {
      throw new Error(
        `Bundle: session ${s.id} appears more than once in sessions.json`,
      );
    }
    seenSessionIds.add(s.id);
    if (typeof row["name"] !== "string") {
      throw new Error(`Bundle: session ${s.id} is missing a string name`);
    }
    if (!VALID_SESSION_STATUSES.has(row["status"] as string)) {
      throw new Error(
        `Bundle: session ${s.id} has invalid status '${row["status"]}'`,
      );
    }
    if (typeof row["createdAt"] !== "number" || !Number.isFinite(row["createdAt"])) {
      throw new Error(`Bundle: session ${s.id} has invalid createdAt`);
    }
    if (typeof row["updatedAt"] !== "number" || !Number.isFinite(row["updatedAt"])) {
      throw new Error(`Bundle: session ${s.id} has invalid updatedAt`);
    }
    if (s.head !== null && typeof s.head !== "string") {
      throw new Error(`Bundle: session ${s.id} has invalid head field`);
    }
    if (s.head !== null && !commitsByHash.has(s.head)) {
      throw new Error(
        `Bundle: session ${s.id} head ${s.head} is missing from commits.jsonl`,
      );
    }
  }

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
