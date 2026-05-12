import Database from "better-sqlite3";
import { SCHEMA_DDL } from "./schema.js";
// ---------------------------------------------------------------------------
// SqliteIndex
// ---------------------------------------------------------------------------
/**
 * better-sqlite3 wrapper that persists session and commit metadata.
 * Applies schema DDL on first open (idempotent via CREATE TABLE IF NOT EXISTS).
 */
export class SqliteIndex {
    db;
    constructor(dbPath) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.db.exec(SCHEMA_DDL);
    }
    /** Wrap fn in a SQLite transaction; re-throws on error and rolls back. */
    transaction(fn) {
        return this.db.transaction(fn)();
    }
    // --------------------------------------------------------------------------
    // Sessions
    // --------------------------------------------------------------------------
    insertSession(session) {
        this.db
            .prepare(`INSERT INTO sessions (id, name, status, head, created_at, updated_at, metadata)
         VALUES (@id, @name, @status, @head, @created_at, @updated_at, @metadata)`)
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
    updateSessionHead(sessionId, head, updatedAt) {
        this.db
            .prepare(`UPDATE sessions SET head = @head, updated_at = @updated_at WHERE id = @id`)
            .run({ id: sessionId, head, updated_at: updatedAt });
    }
    updateSessionStatus(sessionId, status, updatedAt) {
        this.db
            .prepare(`UPDATE sessions SET status = @status, updated_at = @updated_at WHERE id = @id`)
            .run({ id: sessionId, status, updated_at: updatedAt });
    }
    getSession(id) {
        const row = this.db
            .prepare(`SELECT * FROM sessions WHERE id = ?`)
            .get(id);
        return row ? rowToSession(row) : null;
    }
    listSessions() {
        const rows = this.db
            .prepare(`SELECT * FROM sessions ORDER BY created_at DESC`)
            .all();
        return rows.map(rowToSession);
    }
    // --------------------------------------------------------------------------
    // Commits
    // --------------------------------------------------------------------------
    insertCommit(commit) {
        this.db
            .prepare(`INSERT INTO commits (hash, tree, parent, session_id, timestamp, message, tool_call, metadata)
         VALUES (@hash, @tree, @parent, @session_id, @timestamp, @message, @tool_call, @metadata)`)
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
    getCommit(hash) {
        const row = this.db
            .prepare(`SELECT * FROM commits WHERE hash = ?`)
            .get(hash);
        return row ? rowToCommit(row) : null;
    }
    getCommitsBySession(sessionId) {
        const rows = this.db
            .prepare(`SELECT * FROM commits WHERE session_id = ? ORDER BY timestamp ASC`)
            .all(sessionId);
        return rows.map(rowToCommit);
    }
    // --------------------------------------------------------------------------
    // Blobs
    // --------------------------------------------------------------------------
    insertBlob(blob) {
        this.db
            .prepare(`INSERT OR IGNORE INTO blobs (hash, size, mime_type, encoding)
         VALUES (@hash, @size, @mime_type, @encoding)`)
            .run({
            hash: blob.hash,
            size: blob.size,
            mime_type: blob.mimeType,
            encoding: blob.encoding,
        });
    }
    hasBlob(hash) {
        const row = this.db
            .prepare(`SELECT 1 FROM blobs WHERE hash = ?`)
            .get(hash);
        return row !== undefined;
    }
    getBlob(hash) {
        const row = this.db
            .prepare(`SELECT * FROM blobs WHERE hash = ?`)
            .get(hash);
        if (!row)
            return null;
        return {
            hash: row.hash,
            size: row.size,
            mimeType: row.mime_type,
            encoding: row.encoding,
        };
    }
    // --------------------------------------------------------------------------
    // Tree entries
    // --------------------------------------------------------------------------
    insertTreeEntries(treeHash, entries) {
        const stmt = this.db.prepare(`INSERT OR IGNORE INTO tree_entries (tree_hash, path, blob_hash, size)
       VALUES (@tree_hash, @path, @blob_hash, @size)`);
        for (const entry of entries) {
            stmt.run({
                tree_hash: treeHash,
                path: entry.path,
                blob_hash: entry.blobHash,
                size: entry.size,
            });
        }
    }
    getTreeEntries(treeHash) {
        const rows = this.db
            .prepare(`SELECT * FROM tree_entries WHERE tree_hash = ? ORDER BY path ASC`)
            .all(treeHash);
        return rows.map((r) => ({ path: r.path, blobHash: r.blob_hash, size: r.size }));
    }
    // --------------------------------------------------------------------------
    // Refs
    // --------------------------------------------------------------------------
    upsertRef(ref) {
        this.db
            .prepare(`INSERT INTO refs (name, target, type, updated_at)
         VALUES (@name, @target, @type, @updated_at)
         ON CONFLICT(name) DO UPDATE SET
           target = excluded.target,
           type = excluded.type,
           updated_at = excluded.updated_at`)
            .run({
            name: ref.name,
            target: ref.target,
            type: ref.type,
            updated_at: ref.updatedAt,
        });
    }
    getRef(name) {
        const row = this.db
            .prepare(`SELECT * FROM refs WHERE name = ?`)
            .get(name);
        return row ? rowToRef(row) : null;
    }
    listRefs(type) {
        const rows = (type
            ? this.db
                .prepare(`SELECT * FROM refs WHERE type = ? ORDER BY name ASC`)
                .all(type)
            : this.db.prepare(`SELECT * FROM refs ORDER BY name ASC`).all());
        return rows.map(rowToRef);
    }
    deleteRef(name) {
        this.db.prepare(`DELETE FROM refs WHERE name = ?`).run(name);
    }
    /** Close the underlying database connection. */
    close() {
        this.db.close();
    }
}
// ---------------------------------------------------------------------------
// Row → domain type converters
// ---------------------------------------------------------------------------
function rowToSession(row) {
    return {
        id: row.id,
        name: row.name,
        status: row.status,
        head: row.head,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: JSON.parse(row.metadata),
    };
}
function rowToCommit(row) {
    return {
        hash: row.hash,
        type: "commit",
        tree: row.tree,
        parent: row.parent,
        sessionId: row.session_id,
        timestamp: row.timestamp,
        message: row.message,
        toolCall: row.tool_call
            ? JSON.parse(row.tool_call)
            : null,
        metadata: JSON.parse(row.metadata),
    };
}
function rowToRef(row) {
    return {
        name: row.name,
        target: row.target,
        type: row.type,
        updatedAt: row.updated_at,
    };
}
//# sourceMappingURL=sqlite-index.js.map