import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Repository } from "./repository.js";
import type { Blob, Commit, Hash, TreeEntry } from "./types.js";

/**
 * Inputs to {@link cherryPick}.
 *
 * `sourceRef` and `targetRef` may each be:
 *   - a branch name (resolved against `refs/sessions/<name>`),
 *   - a fully-qualified ref path (`sessions/<name>`, `tags/<name>`, …),
 *   - or a full or abbreviated commit hash.
 *
 * When `sessionName` is provided a new session is created and the replayed
 * commits go into it; the target branch ref (if `targetRef` resolved to a
 * branch) is updated to point at the new head.
 *
 * When `sessionName` is omitted the rewritten commits are appended to the
 * session whose `head` already equals the resolved target hash. If no such
 * session exists, the call fails — see the `error` result variant.
 */
export interface CherryPickInput {
  sourceRef: string;
  targetRef: string;
  sessionName?: string;
}

export interface CherryPickOk {
  status: "ok";
  mergeBase: Hash | null;
  /** The new session head after the cherry-pick. */
  newHead: Hash;
  /** Newly created commit hashes, in apply order (oldest first). */
  newCommits: Hash[];
  /** Session that received the replayed commits. */
  sessionId: string;
}

export interface CherryPickConflict {
  status: "conflict";
  /**
   * Most recent common ancestor of source and target, or `null` when the
   * two histories share no ancestor (every source path conflicts with the
   * unrelated target tree).
   */
  mergeBase: Hash | null;
  /** Sorted list of paths in conflict at the first conflicting source step. */
  conflicts: string[];
  /** Hash of the source step whose changes could not be applied cleanly. */
  conflictingStep: Hash;
  /** Absolute path to the CONFLICT directory containing source-side blobs. */
  conflictDir: string;
  /**
   * Conflict paths that were *not* materialised under `conflictDir` because
   * they would have escaped it (absolute paths, `..` segments, etc.). Their
   * conflict status is still authoritative; callers must surface the names
   * but should not trust user-supplied paths to land safely on disk.
   */
  unsafePaths: string[];
}

export interface CherryPickNoop {
  status: "noop";
  reason: string;
  /** The target ref's current commit hash; unchanged. */
  head: Hash;
}

export interface CherryPickError {
  status: "error";
  message: string;
}

export type CherryPickResult =
  | CherryPickOk
  | CherryPickConflict
  | CherryPickNoop
  | CherryPickError;

interface BlobMeta {
  blobHash: Hash;
  size: number;
}

/**
 * Replay the commits between `mergeBase(sourceRef, targetRef)` and
 * `sourceRef` on top of `targetRef`, producing new commits with fresh
 * hashes.
 *
 * Each replayed commit reuses the source commit's `toolCall`, `message`,
 * and `metadata` (with `cherryPickedFrom` added to metadata). The recorded
 * `output` is **not** re-executed — replay reconstructs history, it does
 * not re-run the agent.
 *
 * Conflict detection is **per-step**, not whole-tree: we walk each source
 * commit and check whether the paths it touches still match what the source
 * step expects to find. This catches changes that are invisible in the
 * final source-head tree (e.g. a path that was modified mid-chain and then
 * reverted) but would still clobber target state during replay.
 *
 * On a path-level conflict the call returns `{status: "conflict"}` without
 * mutating any session. The source-side blob content for each conflicting
 * path is written to `.agentgit/CONFLICT/<path>` so the user can inspect
 * or resolve manually.
 */
export function cherryPick(
  repo: Repository,
  input: CherryPickInput,
): CherryPickResult {
  const sourceHash = resolveRef(repo, input.sourceRef);
  if (!sourceHash) {
    return { status: "error", message: `source ref not found: ${input.sourceRef}` };
  }
  const targetHash = resolveRef(repo, input.targetRef);
  if (!targetHash) {
    return { status: "error", message: `target ref not found: ${input.targetRef}` };
  }

  if (sourceHash === targetHash) {
    return {
      status: "noop",
      reason: "source and target point at the same commit",
      head: targetHash,
    };
  }

  const sourceCommit = repo.index.getCommit(sourceHash);
  const targetCommit = repo.index.getCommit(targetHash);
  if (!sourceCommit) {
    return { status: "error", message: `source commit not found: ${sourceHash}` };
  }
  if (!targetCommit) {
    return { status: "error", message: `target commit not found: ${targetHash}` };
  }

  const mergeBase = repo.graph.mergeBase(sourceHash, targetHash);
  if (mergeBase === sourceHash) {
    return {
      status: "noop",
      reason: "source is already an ancestor of target",
      head: targetHash,
    };
  }

  // Source commit chain: oldest first, excluding the merge base.
  const sourceChain = buildChain(repo, sourceHash, mergeBase);
  if (sourceChain.length === 0) {
    return {
      status: "noop",
      reason: "no commits to replay between merge base and source",
      head: targetHash,
    };
  }

  const targetEntriesByPath = entriesMap(repo, targetCommit.tree);

  // ---- Pass 1: per-step conflict dry-run ----------------------------------
  //
  // Walk each source commit, comparing the paths it touches against a
  // simulated running state that starts at target-head. A conflict at step
  // S on path P means: the source step expects to mutate P from some
  // baseline blob (prev[P]) to a target blob (curr[P]), but the simulated
  // state at P diverges from that baseline and does not already match the
  // desired result. Stops at the first conflicting step so the user sees a
  // tight, actionable path list rather than every downstream consequence.

  // Pre-resolve every step's prev/curr maps to avoid duplicating the
  // SQLite lookups across the two passes.
  type StepEntries = { prev: Map<string, TreeEntry>; curr: Map<string, TreeEntry> };
  const stepEntries = new Map<Hash, StepEntries>();
  for (const stepHash of sourceChain) {
    const step = repo.index.getCommit(stepHash);
    if (!step) {
      return {
        status: "error",
        message: `source commit missing from index: ${stepHash}`,
      };
    }
    const curr = entriesMap(repo, step.tree);
    const prev = step.parent
      ? entriesMap(repo, repo.index.getCommit(step.parent)?.tree)
      : new Map<string, TreeEntry>();
    stepEntries.set(stepHash, { prev, curr });
  }

  const dryState = new Map<string, BlobMeta>(
    Array.from(targetEntriesByPath.entries()).map(([p, e]) => [
      p,
      { blobHash: e.blobHash, size: e.size },
    ]),
  );

  let conflictingStep: Hash | null = null;
  let conflictPaths: string[] = [];
  let conflictSourceBlobs: Map<string, Hash> = new Map();

  for (const stepHash of sourceChain) {
    const { prev, curr } = stepEntries.get(stepHash)!;
    const changedPaths = collectChangedPaths(prev, curr);
    const stepConflicts: string[] = [];
    const stepSourceBlobs = new Map<string, Hash>();

    for (const path of changedPaths) {
      const expected = prev.get(path)?.blobHash ?? null;
      const desired = curr.get(path)?.blobHash ?? null;
      const actual = dryState.get(path)?.blobHash ?? null;

      if (actual === desired) {
        // Target already matches the result this step wants — nothing to do
        // for this path, no conflict.
        continue;
      }
      if (actual !== expected) {
        stepConflicts.push(path);
        if (desired !== null) stepSourceBlobs.set(path, desired);
      }
    }

    if (stepConflicts.length > 0) {
      conflictingStep = stepHash;
      conflictPaths = stepConflicts.sort();
      conflictSourceBlobs = stepSourceBlobs;
      break;
    }

    // No conflict at this step — fold it into the simulated state so
    // downstream steps see the post-apply view.
    applyStepToState(dryState, prev, curr);
  }

  if (conflictingStep) {
    const conflictDir = resolve(join(repo.agentgitDir, "CONFLICT"));
    // Always replace the directory so stale conflicts from prior aborted
    // runs don't masquerade as current ones.
    rmSync(conflictDir, { recursive: true, force: true });
    mkdirSync(conflictDir, { recursive: true });
    const unsafePaths: string[] = [];
    for (const path of conflictPaths) {
      const blobHash = conflictSourceBlobs.get(path);
      if (!blobHash) continue; // source-side deletion; nothing to materialise
      if (!isSafeConflictPath(path, conflictDir)) {
        // Untrusted tree paths could otherwise escape CONFLICT/ via "../"
        // segments, absolute paths, or backslash-rooted Windows paths.
        unsafePaths.push(path);
        continue;
      }
      const blob = repo.objects.read(blobHash) as unknown as Blob;
      const out = join(conflictDir, path);
      mkdirSync(dirname(out), { recursive: true });
      const buf = Buffer.from(
        blob.content,
        (blob.encoding ?? "utf-8") as BufferEncoding,
      );
      writeFileSync(out, buf);
    }
    return {
      status: "conflict",
      mergeBase,
      conflicts: conflictPaths,
      conflictingStep,
      conflictDir,
      unsafePaths,
    };
  }

  // ---- Pass 2: actually replay --------------------------------------------
  //
  // We only reach this point when the dry-run pass has confirmed that every
  // step applies cleanly, so no partial mutation can be left behind by a
  // mid-chain failure.

  let sessionId: string;
  if (input.sessionName) {
    const session = repo.createSession(input.sessionName, {
      cherryPickedFrom: input.sourceRef,
      cherryPickedOnto: input.targetRef,
    });
    sessionId = session.id;
  } else {
    const sessions = repo.index.listSessions();
    const owning = sessions.filter((s) => s.head === targetHash);
    if (owning.length === 0) {
      return {
        status: "error",
        message:
          "target ref does not match any session head; pass --session <name> to create a new session",
      };
    }
    if (owning.length > 1) {
      return {
        status: "error",
        message: `target ref is the head of multiple sessions (${owning
          .map((s) => s.name)
          .join(", ")}); pass --session <name> to disambiguate`,
      };
    }
    sessionId = owning[0]!.id;
  }

  const targetBranchRef = matchedBranchRef(repo, input.targetRef, targetHash);

  // Running view of the post-target state, indexed by path.
  const currentState = new Map<string, BlobMeta>(
    Array.from(targetEntriesByPath.entries()).map(([p, e]) => [
      p,
      { blobHash: e.blobHash, size: e.size },
    ]),
  );

  const newCommits: Hash[] = [];
  let parentForNext: Hash = targetHash;

  // Wrap the entire apply pass in a SQLite transaction (better-sqlite3
  // nests via SAVEPOINTs, so inner Repository.commit transactions still
  // work). A runtime failure mid-replay — disk full, missing blob, or
  // any thrown exception — rolls back every commit row, tree-entry, and
  // session-head update written so far, satisfying the
  // "no partial mutation in the target session" acceptance criterion
  // for non-conflict error paths as well. Object-store files written
  // before a rollback remain as content-addressed orphans for GC to
  // sweep later; SQLite is the authoritative source of session state.
  try {
    repo.index.transaction(() => {
      for (const sourceStepHash of sourceChain) {
        const step = repo.index.getCommit(sourceStepHash)!;
        const { prev, curr } = stepEntries.get(sourceStepHash)!;
        applyStepToState(currentState, prev, curr);

        // Materialise the post-state into stateEntries that round-trip
        // through Repository.commit. Reading blob.content + encoding
        // lets the canonical blob hash match the source's hash exactly,
        // so trees and blobs dedupe for free.
        const stateEntries = Array.from(currentState.entries()).map(
          ([path, meta]) => {
            const blob = repo.objects.read(meta.blobHash) as unknown as Blob;
            return {
              path,
              content: blob.content,
              encoding: blob.encoding ?? "utf-8",
              mimeType: blob.mimeType ?? null,
            };
          },
        );

        const newCommit: Commit = repo.commit({
          sessionId,
          message: step.message,
          stateEntries,
          toolCall: step.toolCall,
          parentHash: parentForNext,
          metadata: {
            ...step.metadata,
            cherryPickedFrom: step.hash,
          },
        });
        newCommits.push(newCommit.hash);
        parentForNext = newCommit.hash;
      }
    });
  } catch (err) {
    // Apply pass aborted. SQLite has rolled back; session head and commit
    // rows are exactly as they were before cherry-pick. Surface as an
    // error result rather than letting the exception escape so callers
    // (CLI, SDK, UI) can handle uniformly.
    return {
      status: "error",
      message: `cherry-pick apply pass failed and was rolled back: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (targetBranchRef) {
    repo.refs.setRef(targetBranchRef, parentForNext);
    repo.index.upsertRef({
      name: targetBranchRef,
      target: parentForNext,
      type: "branch",
      updatedAt: Date.now(),
    });
  }

  return {
    status: "ok",
    mergeBase,
    newHead: parentForNext,
    newCommits,
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveRef(repo: Repository, ref: string): Hash | null {
  // Try as a fully-qualified ref path (e.g. "sessions/main") first.
  const direct = repo.refs.getRef(ref);
  if (direct) return direct;
  // Then as a bare branch name under sessions/.
  const branch = repo.refs.getRef(`sessions/${ref}`);
  if (branch) return branch;
  // Finally as a (possibly abbreviated) commit hash.
  try {
    return repo.index.resolveHash(ref);
  } catch {
    return null;
  }
}

function matchedBranchRef(
  repo: Repository,
  ref: string,
  resolvedHash: Hash,
): string | null {
  const direct = repo.refs.getRef(ref);
  if (direct === resolvedHash) return ref;
  const sessions = `sessions/${ref}`;
  const viaSessions = repo.refs.getRef(sessions);
  if (viaSessions === resolvedHash) return sessions;
  return null;
}

function buildChain(
  repo: Repository,
  head: Hash,
  stopAt: Hash | null,
): Hash[] {
  const result: Hash[] = [];
  const visited = new Set<Hash>();
  let cur: Hash | null = head;
  while (cur !== null && cur !== stopAt && !visited.has(cur)) {
    visited.add(cur);
    result.push(cur);
    cur = repo.graph.parent(cur);
  }
  return result.reverse(); // oldest first
}

function entriesMap(
  repo: Repository,
  treeHash: Hash | undefined | null,
): Map<string, TreeEntry> {
  if (!treeHash) return new Map();
  const entries = repo.index.getTreeEntries(treeHash);
  return new Map(entries.map((e) => [e.path, e]));
}

/**
 * Set of paths whose blob hash differs between `prev` and `curr` (including
 * adds and deletes). Unchanged paths are absent.
 */
function collectChangedPaths(
  prev: Map<string, TreeEntry>,
  curr: Map<string, TreeEntry>,
): string[] {
  const changed = new Set<string>();
  for (const [path, entry] of curr) {
    const prior = prev.get(path);
    if (!prior || prior.blobHash !== entry.blobHash) changed.add(path);
  }
  for (const path of prev.keys()) {
    if (!curr.has(path)) changed.add(path);
  }
  return [...changed];
}

/**
 * Reject paths that would land outside `conflictDir` when joined to it:
 *
 *  - absolute paths (`/etc/passwd`, `C:\Windows\...`),
 *  - paths whose normalised form contains a leading `..` segment,
 *  - Windows-style backslash variants of either of the above.
 *
 * Tree-entry paths are user-controlled (they come from whatever the agent
 * wrote into the source session), so we cannot assume they stay inside the
 * agent state namespace. Returning `false` here means the caller records
 * the path in `unsafePaths` instead of writing it.
 */
function isSafeConflictPath(path: string, conflictDir: string): boolean {
  if (path.length === 0) return false;
  if (isAbsolute(path)) return false;
  // Windows treats both "/" and "\" as separators; reject either rooted form.
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  // Reject Windows drive-letter prefixes (`C:foo`, `c:`, `D:\bar`). These
  // pass `isAbsolute` only when they include a separator after the colon,
  // but the drive-relative form `C:foo` can still re-anchor against drive
  // C's per-drive cwd on Windows when fed to `path.resolve`.
  if (/^[A-Za-z]:/.test(path)) return false;
  // Null bytes are not valid in filesystem paths and some filesystem APIs
  // truncate at them — refusing them avoids surprising masking.
  if (path.includes("\0")) return false;
  const joined = resolve(conflictDir, path);
  const prefix = conflictDir.endsWith(sep) ? conflictDir : conflictDir + sep;
  return joined === conflictDir ? false : joined.startsWith(prefix);
}

/**
 * Mutate `state` in place to reflect the diff between `prev` and `curr`:
 * add/modify entries present in `curr`, remove entries present only in
 * `prev`.
 */
function applyStepToState(
  state: Map<string, BlobMeta>,
  prev: Map<string, TreeEntry>,
  curr: Map<string, TreeEntry>,
): void {
  for (const [path, entry] of curr) {
    const prior = prev.get(path);
    if (!prior || prior.blobHash !== entry.blobHash) {
      state.set(path, { blobHash: entry.blobHash, size: entry.size });
    }
  }
  for (const path of prev.keys()) {
    if (!curr.has(path)) state.delete(path);
  }
}
