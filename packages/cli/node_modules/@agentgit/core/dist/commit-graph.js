/**
 * Parent-linked DAG traversal over commit objects in the ObjectStore.
 * Commits form a singly-linked list (each has at most one parent).
 */
export class CommitGraph {
    store;
    constructor(store) {
        this.store = store;
    }
    /**
     * Return commit hashes starting at hash and walking parent links,
     * in reverse-chronological order (newest first).
     * Stops at the root commit (parent === null) or a missing parent.
     */
    ancestors(hash) {
        const result = [];
        const visited = new Set();
        let current = hash;
        while (current !== null && !visited.has(current)) {
            if (!this.store.has(current))
                break;
            visited.add(current);
            result.push(current);
            const obj = this.store.read(current);
            current = obj.parent ?? null;
        }
        return result;
    }
    /**
     * Return just the direct parent hash of a commit, or null for root commits.
     */
    parent(hash) {
        if (!this.store.has(hash))
            return null;
        const obj = this.store.read(hash);
        return obj.parent ?? null;
    }
}
//# sourceMappingURL=commit-graph.js.map