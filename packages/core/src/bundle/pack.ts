import type { Repository } from "../repository.js";
import { canonicalJson } from "../hash.js";
import type { Commit, Ref, Session, TreeEntry } from "../types.js";
import { writeTar, type TarEntry } from "./tar.js";
import { BUNDLE_FORMAT_VERSION, type BundleManifest } from "./manifest.js";

export interface PackInput {
  repo: Repository;
  sessionIds: string[];
  schemaVersion: number;
  generator?: string;
  now?: number;
}

export interface PackResult {
  /** Uncompressed tarball bytes. Callers gzip this themselves. */
  tar: Uint8Array;
  manifest: BundleManifest;
  /** Number of distinct objects (blobs + trees + commits) packed. */
  objectCount: number;
  commitCount: number;
}

interface TreeBody {
  type: "tree";
  entries: TreeEntry[];
}

/**
 * Walk reachable objects from `sessionIds` and emit an uncompressed tar
 * containing manifest.json, the object set, commits.jsonl, refs.json, and
 * sessions.json. The caller is responsible for gzipping the result.
 */
export function pack(input: PackInput): PackResult {
  const sessions: Session[] = [];
  const commits: Commit[] = [];
  const objects = new Map<string, Record<string, unknown>>();

  for (const sid of input.sessionIds) {
    const session = input.repo.index.getSession(sid);
    if (!session) {
      throw new Error(`Bundle: session not found: ${sid}`);
    }
    sessions.push(session);

    for (const commit of input.repo.log(sid)) {
      commits.push(commit);

      if (!objects.has(commit.hash)) {
        objects.set(commit.hash, input.repo.objects.read(commit.hash));
      }
      if (!objects.has(commit.tree)) {
        objects.set(commit.tree, input.repo.objects.read(commit.tree));
      }

      for (const entry of input.repo.index.getTreeEntries(commit.tree)) {
        if (!objects.has(entry.blobHash)) {
          objects.set(entry.blobHash, input.repo.objects.read(entry.blobHash));
        }
      }
    }
  }

  // Refs that point at any included commit are bundled too. Refs targeting
  // commits outside the selected sessions are dropped — they would dangle.
  const includedCommits = new Set(commits.map((c) => c.hash));
  const refs: Ref[] = input.repo.index
    .listRefs()
    .filter((r) => includedCommits.has(r.target));

  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    schemaVersion: input.schemaVersion,
    sessionIds: [...input.sessionIds],
    createdAt: input.now ?? Date.now(),
    generator: input.generator ?? "agentgit/0.1.0",
  };

  const enc = new TextEncoder();
  const entries: TarEntry[] = [];
  entries.push({
    name: "manifest.json",
    data: enc.encode(canonicalJson(manifest)),
  });

  // Stable iteration order: sorted by hash so bundles are reproducible.
  const sortedHashes = [...objects.keys()].sort();
  for (const hash of sortedHashes) {
    const body = objects.get(hash)!;
    entries.push({
      name: `objects/${hash.slice(0, 2)}/${hash.slice(2)}`,
      data: enc.encode(canonicalJson(body)),
    });
  }

  const commitsJsonl =
    commits.map((c) => JSON.stringify(c)).join("\n") +
    (commits.length > 0 ? "\n" : "");
  entries.push({
    name: "commits.jsonl",
    data: enc.encode(commitsJsonl),
  });

  entries.push({
    name: "refs.json",
    data: enc.encode(JSON.stringify(refs)),
  });

  entries.push({
    name: "sessions.json",
    data: enc.encode(JSON.stringify(sessions)),
  });

  return {
    tar: writeTar(entries),
    manifest,
    objectCount: objects.size,
    commitCount: commits.length,
  };
}

// Internal helper retained for tests that want to assert tree shape.
export type { TreeBody };
