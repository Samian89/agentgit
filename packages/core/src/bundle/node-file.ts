import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { TARGET_VERSION } from "../migrations/index.js";
import type { Repository } from "../repository.js";
import type { TreeEntry, Blob, Commit } from "../types.js";
import { pack, type PackResult, type PackInput } from "./pack.js";
import { unpack, type UnpackResult } from "./unpack.js";

export interface CreateBundleOptions {
  repo: Repository;
  sessionIds: string[];
  outPath: string;
  generator?: string;
  /**
   * SQLite schemaVersion to record in the manifest. Defaults to the bundled
   * TARGET_VERSION — callers should normally let this default.
   */
  schemaVersion?: number;
}

/** Pack `sessionIds` and write `<outPath>` as a gzipped tar. */
export function createBundleFile(opts: CreateBundleOptions): PackResult & {
  bytesWritten: number;
} {
  const packInput: PackInput = {
    repo: opts.repo,
    sessionIds: opts.sessionIds,
    schemaVersion: opts.schemaVersion ?? TARGET_VERSION,
  };
  if (opts.generator !== undefined) packInput.generator = opts.generator;
  const result = pack(packInput);
  const gz = gzipSync(Buffer.from(result.tar));
  writeFileSync(opts.outPath, gz);
  return { ...result, bytesWritten: gz.length };
}

export interface ImportBundleOptions {
  repo: Repository;
  filePath: string;
}

export interface ImportBundleResult extends UnpackResult {
  objectsWritten: number;
  commitsInserted: number;
  refsInserted: number;
  sessionsInserted: number;
}

/**
 * Read a `.agentgit-bundle` and restore it into `opts.repo`.
 *
 * Atomicity contract:
 *   1. `unpack()` is the sole validation gate. It verifies every object's
 *      content hash, every commit body's hash, and every internal reference
 *      (commit → tree, commit → parent, tree → blob, ref → commit,
 *      session.head → commit). If `unpack()` returns, the rest of the import
 *      is guaranteed to succeed — no FK violation, no missing target.
 *   2. The SQLite portion runs in a single transaction.
 *   3. Object files are written to `.agentgit/objects/` **only after** the
 *      SQLite transaction commits. A rejected bundle therefore leaves the
 *      filesystem and the database identical to their pre-import state.
 *
 * Idempotent: re-importing the same bundle leaves rows untouched (sessions
 * and commits are skipped if they already exist).
 */
export function importBundleFile(opts: ImportBundleOptions): ImportBundleResult {
  const gz = readFileSync(opts.filePath);
  const tar = gunzipSync(gz);
  const result = unpack(new Uint8Array(tar), {
    clientSchemaVersion: TARGET_VERSION,
  });

  let commitsInserted = 0;
  let refsInserted = 0;
  let sessionsInserted = 0;

  opts.repo.index.transaction(() => {
    // Sessions are inserted with head=null first to avoid a chicken-and-egg
    // FK violation (sessions.head → commits.hash, commits.session_id → sessions.id).
    // The real head is set later in the same transaction, so the DB never
    // observes a sessions row whose head should have been set but wasn't.
    for (const session of result.sessions) {
      if (!opts.repo.index.getSession(session.id)) {
        opts.repo.index.insertSession({ ...session, head: null });
        sessionsInserted++;
      }
    }

    for (const commit of result.commits) {
      if (opts.repo.index.getCommit(commit.hash)) continue;

      // unpack() has already proven the tree exists and every blob it
      // references is in result.objects, so these lookups can't be null.
      const treeBody = result.objects.get(commit.tree)!;
      const treeEntries = treeBody["entries"] as TreeEntry[];
      for (const te of treeEntries) {
        if (opts.repo.index.hasBlob(te.blobHash)) continue;
        const blobBody = result.objects.get(te.blobHash)!;
        const blob: Blob = {
          hash: te.blobHash,
          type: "blob",
          content: String(blobBody["content"] ?? ""),
          size: te.size,
          encoding: (blobBody["encoding"] as "base64" | "utf-8") ?? "utf-8",
          mimeType: (blobBody["mimeType"] as string | null) ?? null,
        };
        opts.repo.index.insertBlob(blob);
      }
      opts.repo.index.insertTreeEntries(commit.tree, treeEntries);

      opts.repo.index.insertCommit(commit);
      commitsInserted++;
    }

    for (const ref of result.refs) {
      opts.repo.index.upsertRef(ref);
      refsInserted++;
    }

    // Reattach session heads inside the same transaction. We only touch heads
    // for sessions that have none — never overwrite a pre-existing head, so a
    // re-import or partial overlap remains idempotent.
    for (const session of result.sessions) {
      const existing = opts.repo.index.getSession(session.id);
      if (existing && existing.head === null && session.head !== null) {
        opts.repo.index.updateSessionHead(
          session.id,
          session.head,
          session.updatedAt,
        );
      }
    }
  });

  // Disk writes happen LAST. ObjectStore.write is idempotent and content-
  // addressed, so writing only after the DB commits means a failure earlier
  // in the pipeline leaves no orphan files in `.agentgit/objects/`.
  let objectsWritten = 0;
  for (const body of result.objects.values()) {
    opts.repo.objects.write(body);
    objectsWritten++;
  }

  return {
    ...result,
    objectsWritten,
    commitsInserted,
    refsInserted,
    sessionsInserted,
  };
}

// Re-export Commit for callers that just want the unpack result shape.
export type { Commit };
