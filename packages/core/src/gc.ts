import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Repository } from "./repository.js";
import type { Hash } from "./types.js";

// ---------------------------------------------------------------------------
// Options / result types
// ---------------------------------------------------------------------------

const DEFAULT_PRUNE_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface GcOptions {
  /**
   * Files in `.agentgit/objects.gc/` whose recorded `deletedAt` is older than
   * this many milliseconds will be hard-deleted before any new orphans are
   * soft-deleted. Defaults to 30 days.
   */
  pruneOlderThanMs?: number;
  /** When true, no filesystem writes occur — actions are only reported. */
  dryRun?: boolean;
  /**
   * When false (default), gc refuses to run if any session is `status='active'`
   * because that session may still write new refs / commits mid-traversal.
   */
  force?: boolean;
  /** Override "now" for deterministic tests. */
  now?: number;
}

export interface GcResult {
  /** Newly soft-deleted hashes (moved from objects/ to objects.gc/). */
  softDeleted: Hash[];
  /** Hashes removed from objects.gc/ during the prune phase. */
  hardDeleted: Hash[];
  /** Reachable object hashes left untouched. */
  reachable: number;
  /** Total object files scanned in `.agentgit/objects/`. */
  scanned: number;
  /** Whether this was a dry-run (no writes performed). */
  dryRun: boolean;
  /**
   * If gc refused to run because an active session was detected and
   * --force was not passed, the offending session IDs. Otherwise null.
   */
  refusedActiveSessions: string[] | null;
}

interface ManifestEntry {
  hash: Hash;
  deletedAt: number;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/**
 * Compute the set of reachable object hashes for this repository.
 *
 * Roots:
 *   - All refs known to RefStore (`.agentgit/refs/<...>`).
 *   - All refs known to the SQLite index (in case the two ever diverge).
 *   - The HEAD pointer, if it resolves to a commit.
 *   - Every session's `head`, regardless of status — `agentgit checkout` can
 *     still target a failed/abandoned session.
 *
 * From each root we walk:
 *   commit -> parent (chain), commit -> tree, tree -> blobHash entries.
 *
 * Objects whose hash is in this set must be preserved by gc.
 */
export function reachableObjects(repo: Repository): Set<Hash> {
  const reachable = new Set<Hash>();
  const queue: Hash[] = [];

  for (const r of repo.refs.listRefs()) {
    if (r.hash) queue.push(r.hash);
  }
  for (const r of repo.index.listRefs()) {
    if (r.target) queue.push(r.target);
  }
  const head = repo.refs.resolveHead();
  if (head) queue.push(head);
  for (const s of repo.index.listSessions()) {
    if (s.head) queue.push(s.head);
  }

  while (queue.length > 0) {
    const hash = queue.shift()!;
    if (reachable.has(hash)) continue;
    if (!repo.objects.has(hash)) continue;
    reachable.add(hash);

    let obj: Record<string, unknown>;
    try {
      obj = repo.objects.read(hash);
    } catch {
      continue;
    }
    const type = obj.type as string | undefined;
    if (type === "commit") {
      const tree = obj.tree as string | undefined;
      const parent = obj.parent as string | null | undefined;
      if (typeof tree === "string") queue.push(tree);
      if (typeof parent === "string") queue.push(parent);
    } else if (type === "tree") {
      const entries = obj.entries as Array<{ blobHash?: string }> | undefined;
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (typeof e.blobHash === "string") queue.push(e.blobHash);
        }
      }
    }
  }

  return reachable;
}

// ---------------------------------------------------------------------------
// Object-store filesystem helpers
// ---------------------------------------------------------------------------

/** Enumerate every `<2>/<62>` file under a sharded object directory. */
function listShardedObjects(dir: string): Hash[] {
  if (!existsSync(dir)) return [];
  const out: Hash[] = [];
  for (const shard of readdirSync(dir)) {
    if (shard.length !== 2) continue;
    const shardPath = join(dir, shard);
    let st;
    try {
      st = statSync(shardPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const file of readdirSync(shardPath)) {
      if (file.length !== 62) continue;
      out.push(shard + file);
    }
  }
  return out;
}

function shardPath(rootDir: string, hash: Hash): string {
  return join(rootDir, hash.slice(0, 2), hash.slice(2));
}

// ---------------------------------------------------------------------------
// Soft-delete manifest
// ---------------------------------------------------------------------------

function manifestPath(gcDir: string): string {
  return join(gcDir, "manifest.jsonl");
}

function readManifest(gcDir: string): ManifestEntry[] {
  const path = manifestPath(gcDir);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return [];
  const entries: ManifestEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ManifestEntry;
      if (typeof parsed.hash === "string" && typeof parsed.deletedAt === "number") {
        entries.push({ hash: parsed.hash, deletedAt: parsed.deletedAt });
      }
    } catch {
      // ignore corrupt manifest lines — they can be reconstructed at next gc
    }
  }
  return entries;
}

function writeManifest(gcDir: string, entries: ManifestEntry[]): void {
  mkdirSync(gcDir, { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(manifestPath(gcDir), entries.length === 0 ? "" : body + "\n", "utf8");
}

function appendManifest(gcDir: string, entry: ManifestEntry): void {
  mkdirSync(gcDir, { recursive: true });
  appendFileSync(manifestPath(gcDir), JSON.stringify(entry) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// gc entry point
// ---------------------------------------------------------------------------

/**
 * Reclaim unreachable objects in two phases:
 *
 *   1. Prune — any file under `.agentgit/objects.gc/` whose recorded
 *      `deletedAt` is older than `pruneOlderThanMs` is hard-deleted from disk
 *      and dropped from the manifest.
 *
 *   2. Soft-delete — every file in `.agentgit/objects/` whose hash is not
 *      reachable from any ref / session head / HEAD is moved to
 *      `.agentgit/objects.gc/<2>/<62>` and recorded in `manifest.jsonl`.
 *
 * Refuses to run with `refusedActiveSessions` populated when any session is
 * still `status='active'` unless `force: true` is passed.
 *
 * `dryRun: true` short-circuits both phases after computing the action set.
 */
export function gc(repo: Repository, options: GcOptions = {}): GcResult {
  const pruneOlderThanMs = options.pruneOlderThanMs ?? DEFAULT_PRUNE_OLDER_THAN_MS;
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const now = options.now ?? Date.now();

  const objectsDir = join(repo.agentgitDir, "objects");
  const gcDir = join(repo.agentgitDir, "objects.gc");

  // Refuse to run if any session is still active.
  if (!force) {
    const active = repo.index
      .listSessions()
      .filter((s) => s.status === "active")
      .map((s) => s.id);
    if (active.length > 0) {
      return {
        softDeleted: [],
        hardDeleted: [],
        reachable: 0,
        scanned: 0,
        dryRun,
        refusedActiveSessions: active,
      };
    }
  }

  // ----- Phase 1: prune old entries from objects.gc/ -----
  const manifest = readManifest(gcDir);
  const cutoff = now - pruneOlderThanMs;
  const hardDeleted: Hash[] = [];
  const survivors: ManifestEntry[] = [];

  for (const entry of manifest) {
    if (entry.deletedAt <= cutoff) {
      const p = shardPath(gcDir, entry.hash);
      if (!dryRun && existsSync(p)) {
        rmSync(p, { force: true });
      }
      hardDeleted.push(entry.hash);
    } else {
      survivors.push(entry);
    }
  }
  if (!dryRun && (hardDeleted.length > 0 || manifest.length !== survivors.length)) {
    writeManifest(gcDir, survivors);
  }

  // ----- Phase 2: soft-delete new orphans from objects/ -----
  const reachable = reachableObjects(repo);
  const onDisk = listShardedObjects(objectsDir);
  const softDeleted: Hash[] = [];

  for (const hash of onDisk) {
    if (reachable.has(hash)) continue;
    softDeleted.push(hash);
    if (dryRun) continue;
    const src = shardPath(objectsDir, hash);
    const dst = shardPath(gcDir, hash);
    mkdirSync(dirname(dst), { recursive: true });
    if (existsSync(dst)) {
      // Already soft-deleted previously — remove the duplicate in objects/.
      rmSync(src, { force: true });
    } else {
      renameSync(src, dst);
    }
    appendManifest(gcDir, { hash, deletedAt: now });
  }

  return {
    softDeleted,
    hardDeleted,
    reachable: reachable.size,
    scanned: onDisk.length,
    dryRun,
    refusedActiveSessions: null,
  };
}
