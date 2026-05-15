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

  /**
   * Lowest common ancestor of two commits, walking single-parent links.
   *
   * Returns the hash of the most recent commit reachable from both `a` and
   * `b` via parent traversal, or null if the two histories never converge
   * (disjoint roots) or either side is missing.
   *
   * `a === b` is a degenerate case that returns `a` itself.
   *
   * Implementation: collect every ancestor of `a` (including `a`) into a
   * set, then walk `b`'s parent chain and return the first hash present in
   * that set. With singly-linked commits, the first hit is necessarily the
   * most recent shared ancestor.
   */
  mergeBase(a: Hash, b: Hash): Hash | null {
    if (a === b) return this.store.has(a) ? a : null;
    const ancestorsOfA = new Set<Hash>(this.ancestors(a));
    if (ancestorsOfA.size === 0) return null;
    let current: Hash | null = b;
    const visited = new Set<Hash>();
    while (current !== null && !visited.has(current)) {
      if (ancestorsOfA.has(current)) return current;
      if (!this.store.has(current)) return null;
      visited.add(current);
      const obj = this.store.read(current) as CommitObject;
      current = obj.parent ?? null;
    }
    return null;
  }
}
