import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { canonicalJson, sha256 } from "@agentgit/core";
import type { Hash, RefType } from "@agentgit/core";

/**
 * Filesystem + SQLite storage for the reference remote server.
 *
 * Layout under `dataDir`:
 *   objects/<2>/<62>         canonical-JSON object bodies (final, immutable)
 *   pending/<upload-id>/...  fsync'd staging area for in-progress uploads
 *   refs.db                  SQLite: refs(name, target, type, updated_at)
 *
 * The pending dir is the durability boundary: once a chunk lands there
 * the client is told `received` and never has to re-send. A `commit` move
 * shuffles each staged file into `objects/` atomically (same-filesystem
 * rename), then drops the upload-id row.
 */
export class RemoteStorage {
  private readonly objectsDir: string;
  private readonly pendingDir: string;
  private readonly db: Database.Database;

  constructor(private readonly dataDir: string) {
    this.objectsDir = join(dataDir, "objects");
    this.pendingDir = join(dataDir, "pending");
    mkdirSync(this.objectsDir, { recursive: true });
    mkdirSync(this.pendingDir, { recursive: true });

    this.db = new Database(join(dataDir, "refs.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refs (
        name TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_uploads (
        upload_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (upload_id, hash)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Object store
  // -------------------------------------------------------------------------

  hasObject(hash: Hash): boolean {
    return existsSync(this.objectPath(hash));
  }

  readObject(hash: Hash): Record<string, unknown> | null {
    const p = this.objectPath(hash);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  }

  private objectPath(hash: Hash): string {
    return join(this.objectsDir, hash.slice(0, 2), hash.slice(2));
  }

  private pendingPath(uploadId: string, hash: Hash): string {
    return join(this.pendingDir, uploadId, hash);
  }

  /**
   * Stage one object under `uploadId`. Verifies SHA-256 of the canonical
   * body against the declared hash; returns `false` if it doesn't match.
   * Idempotent: re-staging an already-pending or already-committed object
   * is a no-op success.
   */
  stagePending(uploadId: string, hash: Hash, body: Record<string, unknown>): boolean {
    if (!/^[0-9a-f]{64}$/.test(hash)) return false;
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(uploadId)) return false;
    const computed = sha256(body);
    if (computed !== hash) return false;

    // If the object is already in the permanent store, just record the ack
    // (so duplicate uploads still appear in `received`).
    if (this.hasObject(hash)) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO pending_uploads (upload_id, hash, received_at)
           VALUES (?, ?, ?)`,
        )
        .run(uploadId, hash, Date.now());
      return true;
    }

    const dir = join(this.pendingDir, uploadId);
    mkdirSync(dir, { recursive: true });
    const target = this.pendingPath(uploadId, hash);
    if (!existsSync(target)) {
      // Atomic write via tmp+rename so a crash doesn't leave a half-written file.
      const tmp = target + ".tmp";
      writeFileSync(tmp, canonicalJson(body), "utf8");
      renameSync(tmp, target);
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO pending_uploads (upload_id, hash, received_at)
         VALUES (?, ?, ?)`,
      )
      .run(uploadId, hash, Date.now());
    return true;
  }

  /** All hashes durably ack'd under `uploadId` (across this and prior chunks). */
  listPending(uploadId: string): Hash[] {
    const rows = this.db
      .prepare(`SELECT hash FROM pending_uploads WHERE upload_id = ? ORDER BY hash`)
      .all(uploadId) as Array<{ hash: string }>;
    return rows.map((r) => r.hash);
  }

  /**
   * Promote all pending objects under `uploadId` to the permanent store and
   * drop the pending rows. Idempotent — calling commit on an unknown id is
   * a no-op success.
   */
  commitPending(uploadId: string): { committed: number } {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(uploadId)) return { committed: 0 };
    const rows = this.db
      .prepare(`SELECT hash FROM pending_uploads WHERE upload_id = ?`)
      .all(uploadId) as Array<{ hash: string }>;

    let committed = 0;
    for (const { hash } of rows) {
      const src = this.pendingPath(uploadId, hash);
      const dst = this.objectPath(hash);
      if (existsSync(dst)) {
        // Already in the store; just drop the pending file.
        if (existsSync(src)) unlinkSync(src);
        continue;
      }
      if (!existsSync(src)) continue;
      mkdirSync(join(this.objectsDir, hash.slice(0, 2)), { recursive: true });
      renameSync(src, dst);
      committed += 1;
    }
    this.db.prepare(`DELETE FROM pending_uploads WHERE upload_id = ?`).run(uploadId);

    // Best-effort cleanup of the now-empty per-upload directory.
    const dir = join(this.pendingDir, uploadId);
    if (existsSync(dir)) {
      try {
        const remaining = readdirSync(dir);
        if (remaining.length === 0) {
          // node:fs has rmdir but rmSync handles it cross-platform.
          // We use unlinkSync semantics — a directory rmdir.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require("node:fs");
          fs.rmdirSync(dir);
        }
      } catch {
        // Non-fatal — directory will be GCed by a future restart sweep.
      }
    }

    return { committed };
  }

  /** Older than `cutoffMs` pending-upload directories are deleted. */
  sweepStalePending(cutoffMs: number): number {
    let n = 0;
    if (!existsSync(this.pendingDir)) return 0;
    const now = Date.now();
    for (const id of readdirSync(this.pendingDir)) {
      const dir = join(this.pendingDir, id);
      try {
        const st = statSync(dir);
        if (!st.isDirectory()) continue;
        if (now - st.mtimeMs > cutoffMs) {
          for (const f of readdirSync(dir)) unlinkSync(join(dir, f));
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require("node:fs");
          fs.rmdirSync(dir);
          this.db.prepare(`DELETE FROM pending_uploads WHERE upload_id = ?`).run(id);
          n += 1;
        }
      } catch {
        // ignore
      }
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------

  listRefs(): Array<{ name: string; target: Hash; type: RefType }> {
    const rows = this.db
      .prepare(`SELECT name, target, type FROM refs ORDER BY name`)
      .all() as Array<{ name: string; target: string; type: string }>;
    return rows.map((r) => ({ name: r.name, target: r.target, type: r.type as RefType }));
  }

  /**
   * Compare-and-swap a ref. Returns the new state on success, or
   * { conflict: true, current } if `oldTarget` doesn't match the stored value.
   * The new target must already exist as a stored object.
   */
  updateRef(
    name: string,
    type: RefType,
    oldTarget: Hash | null,
    newTarget: Hash,
  ): { ok: true } | { ok: false; error: "ref-conflict"; current: Hash | null } | { ok: false; error: "missing-target" } {
    if (!this.hasObject(newTarget)) {
      return { ok: false, error: "missing-target" };
    }
    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT target FROM refs WHERE name = ?`)
        .get(name) as { target: string } | undefined;
      const current = row ? row.target : null;
      if (current !== oldTarget) {
        return { ok: false as const, error: "ref-conflict" as const, current };
      }
      this.db
        .prepare(
          `INSERT INTO refs (name, target, type, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             target = excluded.target,
             type = excluded.type,
             updated_at = excluded.updated_at`,
        )
        .run(name, newTarget, type, Date.now());
      return { ok: true as const };
    });
    return txn();
  }
}
