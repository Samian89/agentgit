import { ObjectStore } from "./object-store.js";
import { CommitGraph } from "./commit-graph.js";
import { RefStore } from "./ref-store.js";
import { SqliteIndex } from "./sqlite-index.js";
import type { Commit, Hash, Session, SessionStatus, StepDiff, ToolCall } from "./types.js";
export interface StateEntry {
    /** Logical path within the agent state namespace (e.g. "files/main.py"). */
    path: string;
    /** Text or base64 content. */
    content: string;
    /** Storage encoding. Defaults to "utf-8". */
    encoding?: "base64" | "utf-8";
    /** MIME type hint. */
    mimeType?: string | null;
}
export interface CommitInput {
    sessionId: string;
    message: string;
    /** State snapshot entries; empty array records an empty tree. */
    stateEntries?: StateEntry[];
    /** Tool call that produced this commit. */
    toolCall?: ToolCall | null;
    /** Arbitrary commit metadata. */
    metadata?: Record<string, unknown>;
    /** Explicit parent hash. If omitted, the session's current head is used. */
    parentHash?: Hash | null;
}
/**
 * Unified entry point orchestrating ObjectStore, CommitGraph, RefStore, and
 * SqliteIndex. All four collaborate to give a complete, tamper-evident audit
 * trail for an agent session.
 */
export declare class Repository {
    readonly agentgitDir: string;
    readonly objects: ObjectStore;
    readonly refs: RefStore;
    readonly index: SqliteIndex;
    readonly graph: CommitGraph;
    private constructor();
    /**
     * Initialise a new .agentgit/ directory at agentgitDir.
     * Safe to call on an existing store — all operations are idempotent.
     */
    static init(agentgitDir: string): Repository;
    /** Open an existing repository without reinitialising it. */
    static open(agentgitDir: string): Repository;
    /** Create a new session and persist it to the index. */
    createSession(name: string, metadata?: Record<string, unknown>): Session;
    getSession(id: string): Session | null;
    updateSessionStatus(id: string, status: SessionStatus): void;
    /**
     * Record a new commit.
     * 1. Writes blob objects for each state entry.
     * 2. Writes the tree object.
     * 3. Writes the commit object.
     * 4. Persists blobs, tree entries, commit, and session head update atomically
     *    in a single SQLite transaction.
     *
     * Returns the complete Commit (with hash attached).
     */
    commit(input: CommitInput): Commit;
    /** Return all commits for sessionId in ascending timestamp order. */
    log(sessionId: string): Commit[];
    /** Walk parent links from hash; returns hashes newest-first. */
    ancestors(hash: Hash): Hash[];
    /**
     * Compute a step-level diff between two commits.
     * Reads tree entries from the SQLite index for performance.
     */
    diff(fromHash: Hash, toHash: Hash): StepDiff;
    /** Create or update a named branch ref pointing to commitHash. */
    createBranch(name: string, commitHash: Hash): void;
    /** Read a branch ref; returns null if not found. */
    getBranch(name: string): Hash | null;
    /** Compute the SHA-256 hash for an arbitrary object (exposed for testing). */
    static hashObject(obj: Record<string, unknown>): Hash;
}
//# sourceMappingURL=repository.d.ts.map