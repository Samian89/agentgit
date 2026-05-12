import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./hash.js";
import { ObjectStore } from "./object-store.js";
import { CommitGraph } from "./commit-graph.js";
import { RefStore } from "./ref-store.js";
import { SqliteIndex } from "./sqlite-index.js";
// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------
/**
 * Unified entry point orchestrating ObjectStore, CommitGraph, RefStore, and
 * SqliteIndex. All four collaborate to give a complete, tamper-evident audit
 * trail for an agent session.
 */
export class Repository {
    agentgitDir;
    objects;
    refs;
    index;
    graph;
    constructor(agentgitDir, objects, refs, index, graph) {
        this.agentgitDir = agentgitDir;
        this.objects = objects;
        this.refs = refs;
        this.index = index;
        this.graph = graph;
    }
    /**
     * Initialise a new .agentgit/ directory at agentgitDir.
     * Safe to call on an existing store — all operations are idempotent.
     */
    static init(agentgitDir) {
        mkdirSync(join(agentgitDir, "objects"), { recursive: true });
        mkdirSync(join(agentgitDir, "refs"), { recursive: true });
        const objects = new ObjectStore(join(agentgitDir, "objects"));
        const refs = new RefStore(agentgitDir);
        const index = new SqliteIndex(join(agentgitDir, "index.db"));
        const graph = new CommitGraph(objects);
        return new Repository(agentgitDir, objects, refs, index, graph);
    }
    /** Open an existing repository without reinitialising it. */
    static open(agentgitDir) {
        return Repository.init(agentgitDir);
    }
    // --------------------------------------------------------------------------
    // Sessions
    // --------------------------------------------------------------------------
    /** Create a new session and persist it to the index. */
    createSession(name, metadata = {}) {
        const now = Date.now();
        const session = {
            id: crypto.randomUUID(),
            name,
            status: "active",
            head: null,
            createdAt: now,
            updatedAt: now,
            metadata,
        };
        this.index.insertSession(session);
        return session;
    }
    getSession(id) {
        return this.index.getSession(id);
    }
    updateSessionStatus(id, status) {
        this.index.updateSessionStatus(id, status, Date.now());
    }
    // --------------------------------------------------------------------------
    // Commits
    // --------------------------------------------------------------------------
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
    commit(input) {
        const { sessionId, message, stateEntries = [], toolCall = null, metadata = {}, } = input;
        const now = Date.now();
        // Resolve parent
        const parentHash = "parentHash" in input
            ? (input.parentHash ?? null)
            : (this.index.getSession(sessionId)?.head ?? null);
        // Build blobs and tree entries
        const blobs = [];
        const treeEntries = [];
        for (const entry of stateEntries) {
            const encoding = entry.encoding ?? "utf-8";
            const rawBytes = Buffer.from(entry.content, encoding);
            const size = rawBytes.length;
            const mimeType = entry.mimeType ?? null;
            const blobBody = {
                type: "blob",
                content: entry.content,
                size,
                encoding,
                mimeType,
            };
            const blobHash = this.objects.write(blobBody);
            blobs.push({ hash: blobHash, ...blobBody });
            treeEntries.push({ path: entry.path, blobHash, size });
        }
        // Build and write tree
        const treeBody = {
            type: "tree",
            entries: treeEntries,
        };
        const treeHash = this.objects.write(treeBody);
        // Build and write commit
        const commitBody = {
            type: "commit",
            tree: treeHash,
            parent: parentHash,
            sessionId,
            timestamp: now,
            message,
            toolCall,
            metadata,
        };
        const commitHash = this.objects.write(commitBody);
        const fullCommit = { hash: commitHash, ...commitBody };
        // Persist to SQLite atomically
        this.index.transaction(() => {
            for (const blob of blobs) {
                this.index.insertBlob(blob);
            }
            this.index.insertTreeEntries(treeHash, treeEntries);
            this.index.insertCommit(fullCommit);
            this.index.updateSessionHead(sessionId, commitHash, now);
        });
        return fullCommit;
    }
    // --------------------------------------------------------------------------
    // Log
    // --------------------------------------------------------------------------
    /** Return all commits for sessionId in ascending timestamp order. */
    log(sessionId) {
        return this.index.getCommitsBySession(sessionId);
    }
    // --------------------------------------------------------------------------
    // Ancestor traversal
    // --------------------------------------------------------------------------
    /** Walk parent links from hash; returns hashes newest-first. */
    ancestors(hash) {
        return this.graph.ancestors(hash);
    }
    // --------------------------------------------------------------------------
    // Diff
    // --------------------------------------------------------------------------
    /**
     * Compute a step-level diff between two commits.
     * Reads tree entries from the SQLite index for performance.
     */
    diff(fromHash, toHash) {
        const fromCommit = this.index.getCommit(fromHash);
        const toCommit = this.index.getCommit(toHash);
        const fromEntries = new Map((fromCommit ? this.index.getTreeEntries(fromCommit.tree) : []).map((e) => [
            e.path,
            e,
        ]));
        const toEntries = new Map((toCommit ? this.index.getTreeEntries(toCommit.tree) : []).map((e) => [
            e.path,
            e,
        ]));
        const added = [];
        const removed = [];
        const modified = [];
        for (const [path, toEntry] of toEntries) {
            const fromEntry = fromEntries.get(path);
            if (!fromEntry) {
                added.push({ path, fromHash: null, toHash: toEntry.blobHash, sizeDelta: toEntry.size });
            }
            else if (fromEntry.blobHash !== toEntry.blobHash) {
                modified.push({
                    path,
                    fromHash: fromEntry.blobHash,
                    toHash: toEntry.blobHash,
                    sizeDelta: toEntry.size - fromEntry.size,
                });
            }
        }
        for (const [path, fromEntry] of fromEntries) {
            if (!toEntries.has(path)) {
                removed.push({
                    path,
                    fromHash: fromEntry.blobHash,
                    toHash: null,
                    sizeDelta: -fromEntry.size,
                });
            }
        }
        return { fromHash, toHash, added, removed, modified };
    }
    // --------------------------------------------------------------------------
    // Refs (convenience wrappers)
    // --------------------------------------------------------------------------
    /** Create or update a named branch ref pointing to commitHash. */
    createBranch(name, commitHash) {
        this.refs.setRef(`sessions/${name}`, commitHash);
        this.index.upsertRef({
            name: `sessions/${name}`,
            target: commitHash,
            type: "branch",
            updatedAt: Date.now(),
        });
    }
    /** Read a branch ref; returns null if not found. */
    getBranch(name) {
        return this.refs.getRef(`sessions/${name}`);
    }
    /** Compute the SHA-256 hash for an arbitrary object (exposed for testing). */
    static hashObject(obj) {
        return sha256(obj);
    }
}
//# sourceMappingURL=repository.js.map