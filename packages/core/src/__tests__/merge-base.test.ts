import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repository } from "../repository.js";
import type { Hash } from "../types.js";

let dir: string;
let repo: Repository;

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-merge-base-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  repo = Repository.init(join(dir, ".agentgit"));
});

afterEach(() => {
  try {
    repo.index.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

function commit(
  sessionId: string,
  message: string,
  parent: Hash | null,
  path: string,
  content: string,
): Hash {
  return repo.commit({
    sessionId,
    message,
    parentHash: parent,
    stateEntries: [{ path, content }],
  }).hash;
}

describe("CommitGraph.mergeBase", () => {
  it("returns the same hash when a === b", () => {
    const s = repo.createSession("s");
    const c1 = commit(s.id, "c1", null, "a.txt", "v1");
    expect(repo.mergeBase(c1, c1)).toBe(c1);
  });

  it("returns the older commit on a linear ancestor chain", () => {
    const s = repo.createSession("s");
    const c1 = commit(s.id, "c1", null, "a.txt", "v1");
    const c2 = commit(s.id, "c2", c1, "a.txt", "v2");
    const c3 = commit(s.id, "c3", c2, "a.txt", "v3");

    expect(repo.mergeBase(c3, c1)).toBe(c1);
    expect(repo.mergeBase(c1, c3)).toBe(c1);
    expect(repo.mergeBase(c2, c3)).toBe(c2);
  });

  it("returns the fork point on a simple fork graph", () => {
    // c1 -> c2 -> c3 (branch A)
    //         \-> c4 (branch B)
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const c1 = commit(sA.id, "c1", null, "a.txt", "v1");
    const c2 = commit(sA.id, "c2", c1, "a.txt", "v2");
    const c3 = commit(sA.id, "c3", c2, "a.txt", "v3");
    const c4 = commit(sB.id, "c4", c2, "b.txt", "vB");

    expect(repo.mergeBase(c3, c4)).toBe(c2);
    expect(repo.mergeBase(c4, c3)).toBe(c2);
  });

  it("returns the most recent fork on a double-fork graph", () => {
    // c1 -> c2 -> c3 -> c4 (branch A)
    //              \-> c5 -> c6 (branch B)
    //         \-> c7 -> c8 (branch C)
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const sC = repo.createSession("C");
    const c1 = commit(sA.id, "c1", null, "a", "v1");
    const c2 = commit(sA.id, "c2", c1, "a", "v2");
    const c3 = commit(sA.id, "c3", c2, "a", "v3");
    const c4 = commit(sA.id, "c4", c3, "a", "v4");
    const c5 = commit(sB.id, "c5", c3, "b", "vB1");
    const c6 = commit(sB.id, "c6", c5, "b", "vB2");
    const c7 = commit(sC.id, "c7", c2, "c", "vC1");
    const c8 = commit(sC.id, "c8", c7, "c", "vC2");

    // A and B fork at c3 (the most recent common ancestor — not c2).
    expect(repo.mergeBase(c4, c6)).toBe(c3);
    // A and C fork at c2.
    expect(repo.mergeBase(c4, c8)).toBe(c2);
    // B and C fork at c2 — the more recent fork of A (c3) isn't on C's chain.
    expect(repo.mergeBase(c6, c8)).toBe(c2);
  });

  it("returns null for disjoint roots", () => {
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const a = commit(sA.id, "a", null, "a", "vA");
    const b = commit(sB.id, "b", null, "b", "vB");
    expect(repo.mergeBase(a, b)).toBeNull();
  });
});
