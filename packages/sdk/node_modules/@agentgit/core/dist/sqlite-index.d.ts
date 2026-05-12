import type { Blob, Commit, Hash, Ref, RefType, Session, SessionStatus, TreeEntry } from "./types.js";
/**
 * better-sqlite3 wrapper that persists session and commit metadata.
 * Applies schema DDL on first open (idempotent via CREATE TABLE IF NOT EXISTS).
 */
export declare class SqliteIndex {
    private readonly db;
    constructor(dbPath: string);
    /** Wrap fn in a SQLite transaction; re-throws on error and rolls back. */
    transaction<T>(fn: () => T): T;
    insertSession(session: Session): void;
    updateSessionHead(sessionId: string, head: Hash | null, updatedAt: number): void;
    updateSessionStatus(sessionId: string, status: SessionStatus, updatedAt: number): void;
    getSession(id: string): Session | null;
    listSessions(): Session[];
    insertCommit(commit: Commit): void;
    getCommit(hash: Hash): Commit | null;
    getCommitsBySession(sessionId: string): Commit[];
    insertBlob(blob: Blob): void;
    hasBlob(hash: Hash): boolean;
    getBlob(hash: Hash): Pick<Blob, "hash" | "size" | "mimeType" | "encoding"> | null;
    insertTreeEntries(treeHash: Hash, entries: TreeEntry[]): void;
    getTreeEntries(treeHash: Hash): TreeEntry[];
    upsertRef(ref: Ref): void;
    getRef(name: string): Ref | null;
    listRefs(type?: RefType): Ref[];
    deleteRef(name: string): void;
    /** Close the underlying database connection. */
    close(): void;
}
//# sourceMappingURL=sqlite-index.d.ts.map