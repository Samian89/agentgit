import Database from "better-sqlite3";
import { SCHEMA_DDL } from "./schema.js";
import type {
  Blob,
  Commit,
  Hash,
  Ref,
  RefType,
  Session,
  SessionStatus,
  ToolCall,
  TreeEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Row types — shapes returned by better-sqlite3 (snake_case column names)
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  name: string;
  status: string;
  head: string | null;
  created_at: number;
  updated_at: number;
  metadata: string;
}

interface CommitRow {
  hash: string;
  tree: string;
  parent: string | null;
  session_id: string;
  timestamp: number;
  message: string;
  tool_call: string | null;
  metadata: string;
}

interface BlobRow {
  hash: string;
  size: number;
  mime_type: string | null;
  encoding: string;
}

interface RefRow {
  name: string;
  target: string;
  type: string;
  updated_at: number;
}

interface TreeEntryRow {
  tree_hash: string;
  path: string;
  blob_hash: string;
  size: number;
}

// ---------------------------------------------------------------------------
// SqliteIndex
// ---------------------------------------------------------------------------

/**
 * better-sqlite3 wrapper that persists session and commit metadata.
 * Applies schema DDL on first open (idempotent via CREATE TABLE IF NOT EXISTS).
 */
export class SqliteIndex {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_DDL);
  }

  /** Wrap fn in a SQLite transaction; re-throws on error and rolls back. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)() as T;
  }

  // --------------------------------------------------------------------------
  // Sessions
  // --------------------------------------------------------------------------

  insertSession(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, status, head, created_at, updated_at, metadata)
         VALUES (@id, @name, @status, @head, @created_at, @updated_at, @metadata)`,
      )
      .run({
        id: session.id,
        name: session.name,
        status: session.status,
        head: session.head,
        created_at: session.createdAt,
        updated_at: session.updatedAt,
        metadata: JSON.stringify(session.metadata),
      });
  }

  updateSessionHead(sessionId: string, head: Hash | null, updatedAt: number): void {
    this.db
      .prepare(`UPDATE sessions SET head = @head, updated_at = @updated_at WHERE id = @id`)
      .run({ id: sessionId, head, updated_at: updatedAt });
  }

  updateSessionStatus(sessionId: string, status: SessionStatus, updatedAt: number): void {
    this.db
      .prepare(`UPDATE sessions SET status = @status, updated_at = @updated_at WHERE id = @id`)
      .run({ id: sessionId, status, updated_at: updatedAt });
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  listSessions(): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY created_at DESC`)
      .all() as SessionRow[];
    return rows.map(rowToSession);
  }

  // --------------------------------------------------------------------------
  // Commits
  // --------------------------------------------------------------------------

  insertCommit(commit: Commit): void {
    this.db
      .prepare(
        `INSERT INTO commits (hash, tree, parent, session_id, timestamp, message, tool_call, metadata)
         VALUES (@hash, @tree, @parent, @session_id, @timestamp, @message, @tool_call, @metadata)`,
      )
      .run({
        hash: commit.hash,
        tree: commit.tree,
        parent: commit.parent,
        session_id: commit.sessionId,
        timestamp: commit.timestamp,
        message: commit.message,
        tool_call: commit.toolCall !== null ? JSON.stringify(commit.toolCall) : null,
        metadata: JSON.stringify(commit.metadata),
      });
  }

  getCommit(hash: Hash): Commit | null {
    const row = this.db
      .prepare(`SELECT * FROM commits WHERE hash = ?`)
      .get(hash) as CommitRow | undefined;
    return row ? rowToCommit(row) : null;
  }

  getCommitsBySession(sessionId: string): Commit[] {
    const rows = this.db
      .prepare(`SELECT * FROM commits WHERE session_id = ? ORDER BY timestamp ASC`)
      .all(sessionId) as CommitRow[];
    return rows.map(rowToCommit);
  }

  // --------------------------------------------------------------------------
  // Blobs
  // --------------------------------------------------------------------------

  insertBlob(blob: Blob): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO blobs (hash, size, mime_type, encoding)
         VALUES (@hash, @size, @mime_type, @encoding)`,
      )
      .run({
        hash: blob.hash,
        size: blob.size,
        mime_type: blob.mimeType,
        encoding: blob.encoding,
      });
  }

  hasBlob(hash: Hash): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM blobs WHERE hash = ?`)
      .get(hash);
    return row !== undefined;
  }

  getBlob(hash: Hash): Pick<Blob, "hash" | "size" | "mimeType" | "encoding"> | null {
    const row = this.db
      .prepare(`SELECT * FROM blobs WHERE hash = ?`)
      .get(hash) as BlobRow | undefined;
    if (!row) return null;
    return {
      hash: row.hash,
      size: row.size,
      mimeType: row.mime_type,
      encoding: row.encoding as "base64" | "utf-8",
    };
  }

  // --------------------------------------------------------------------------
  // Tree entries
  // --------------------------------------------------------------------------

  insertTreeEntries(treeHash: Hash, entries: TreeEntry[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO tree_entries (tree_hash, path, blob_hash, size)
       VALUES (@tree_hash, @path, @blob_hash, @size)`,
    );
    for (const entry of entries) {
      stmt.run({
        tree_hash: treeHash,
        path: entry.path,
        blob_hash: entry.blobHash,
        size: entry.size,
      });
    }
  }

  getTreeEntries(treeHash: Hash): TreeEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM tree_entries WHERE tree_hash = ? ORDER BY path ASC`)
      .all(treeHash) as TreeEntryRow[];
    return rows.map((r) => ({ path: r.path, blobHash: r.blob_hash, size: r.size }));
  }

  // --------------------------------------------------------------------------
  // Refs
  // --------------------------------------------------------------------------

  upsertRef(ref: Ref): void {
    this.db
      .prepare(
        `INSERT INTO refs (name, target, type, updated_at)
         VALUES (@name, @target, @type, @updated_at)
         ON CONFLICT(name) DO UPDATE SET
           target = excluded.target,
           type = excluded.type,
           updated_at = excluded.updated_at`,
      )
      .run({
        name: ref.name,
        target: ref.target,
        type: ref.type,
        updated_at: ref.updatedAt,
      });
  }

  getRef(name: string): Ref | null {
    const row = this.db
      .prepare(`SELECT * FROM refs WHERE name = ?`)
      .get(name) as RefRow | undefined;
    return row ? rowToRef(row) : null;
  }

  listRefs(type?: RefType): Ref[] {
    const rows = (
      type
        ? (this.db
            .prepare(`SELECT * FROM refs WHERE type = ? ORDER BY name ASC`)
            .all(type) as RefRow[])
        : (this.db.prepare(`SELECT * FROM refs ORDER BY name ASC`).all() as RefRow[])
    );
    return rows.map(rowToRef);
  }

  deleteRef(name: string): void {
    this.db.prepare(`DELETE FROM refs WHERE name = ?`).run(name);
  }

  /**
   * Resolve a full or abbreviated commit hash to a full 64-char hash.
   * Returns the full hash if exactly one commit matches the prefix.
   * Returns null if no commit matches.
   * Throws if the prefix is ambiguous (matches more than one commit).
   */
  resolveHash(prefix: string): Hash | null {
    if (prefix.length === 64) {
      const row = this.db
        .prepare(`SELECT hash FROM commits WHERE hash = ?`)
        .get(prefix) as { hash: string } | undefined;
      return row ? row.hash : null;
    }
    const rows = this.db
      .prepare(`SELECT hash FROM commits WHERE hash LIKE ?`)
      .all(prefix + "%") as { hash: string }[];
    if (rows.length === 0) return null;
    if (rows.length === 1) return rows[0]!.hash;
    throw new Error(
      `Ambiguous commit prefix '${prefix}' matches ${rows.length} commits`,
    );
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Row → domain type converters
// ---------------------------------------------------------------------------

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    status: row.status as SessionStatus,
    head: row.head,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

function rowToCommit(row: CommitRow): Commit {
  return {
    hash: row.hash,
    type: "commit",
    tree: row.tree,
    parent: row.parent,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    message: row.message,
    toolCall: row.tool_call
      ? (JSON.parse(row.tool_call) as ToolCall)
      : null,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

function rowToRef(row: RefRow): Ref {
  return {
    name: row.name,
    target: row.target,
    type: row.type as RefType,
    updatedAt: row.updated_at,
  };
}
