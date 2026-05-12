import type { Hash } from "./types.js";
import type { ObjectStore } from "./object-store.js";

interface CommitObject {
  parent?: Hash | null;
}

/**
 * Parent-linked DAG traversal over commit objects in the ObjectStore.
 * Commits form a singly-linked list (each has at most one parent).
 */
export class CommitGraph {
  constructor(private readonly store: ObjectStore) {}

  /**
   * Return commit hashes starting at hash and walking parent links,
   * in reverse-chronological order (newest first).
   * Stops at the root commit (parent === null) or a missing parent.
   */
  ancestors(hash: Hash): Hash[] {
    const result: Hash[] = [];
    const visited = new Set<Hash>();
    let current: Hash | null = hash;

    while (current !== null && !visited.has(current)) {
      if (!this.store.has(current)) break;
      visited.add(current);
      result.push(current);
      const obj = this.store.read(current) as CommitObject;
      current = obj.parent ?? null;
    }

    return result;
  }

  /**
   * Return just the direct parent hash of a commit, or null for root commits.
   */
  parent(hash: Hash): Hash | null {
    if (!this.store.has(hash)) return null;
    const obj = this.store.read(hash) as CommitObject;
    return obj.parent ?? null;
  }
}
