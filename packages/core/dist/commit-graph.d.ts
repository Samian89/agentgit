import type { Hash } from "./types.js";
import type { ObjectStore } from "./object-store.js";
/**
 * Parent-linked DAG traversal over commit objects in the ObjectStore.
 * Commits form a singly-linked list (each has at most one parent).
 */
export declare class CommitGraph {
    private readonly store;
    constructor(store: ObjectStore);
    /**
     * Return commit hashes starting at hash and walking parent links,
     * in reverse-chronological order (newest first).
     * Stops at the root commit (parent === null) or a missing parent.
     */
    ancestors(hash: Hash): Hash[];
    /**
     * Return just the direct parent hash of a commit, or null for root commits.
     */
    parent(hash: Hash): Hash | null;
}
//# sourceMappingURL=commit-graph.d.ts.map