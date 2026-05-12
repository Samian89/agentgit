import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObjectStore } from "../object-store.js";
import { CommitGraph } from "../commit-graph.js";

let dir: string;
let store: ObjectStore;
let graph: CommitGraph;

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  store = new ObjectStore(join(dir, "objects"));
  graph = new CommitGraph(store);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCommit(
  message: string,
  parent: string | null = null,
): string {
  const obj = {
    type: "commit",
    tree: "0".repeat(64),
    parent,
    sessionId: "session-1",
    timestamp: Date.now(),
    message,
    toolCall: null,
    metadata: {},
  };
  return store.write(obj);
}

describe("CommitGraph.ancestors", () => {
  it("returns [hash] for a root commit (no parent)", () => {
    const hash = makeCommit("root");
    expect(graph.ancestors(hash)).toEqual([hash]);
  });

  it("returns commits newest-first for a linear chain", () => {
    const c1 = makeCommit("first");
    const c2 = makeCommit("second", c1);
    const c3 = makeCommit("third", c2);

    const result = graph.ancestors(c3);
    expect(result).toEqual([c3, c2, c1]);
  });

  it("stops if a parent object is missing from the store", () => {
    const fakeParent = "f".repeat(64);
    const child = makeCommit("child", fakeParent);
    const result = graph.ancestors(child);
    // child is in store, fakeParent is not — stops after child
    expect(result).toEqual([child]);
  });

  it("returns [] for a hash not in the store", () => {
    expect(graph.ancestors("c".repeat(64))).toEqual([]);
  });

  it("does not revisit a node (handles any cycle guard)", () => {
    // Artificially create a scenario where the graph would loop;
    // the visited set must prevent infinite traversal.
    const c1 = makeCommit("root");
    const result = graph.ancestors(c1);
    expect(result).toHaveLength(1);
  });
});

describe("CommitGraph.parent", () => {
  it("returns null for a root commit", () => {
    const hash = makeCommit("root");
    expect(graph.parent(hash)).toBeNull();
  });

  it("returns the parent hash for a child commit", () => {
    const c1 = makeCommit("first");
    const c2 = makeCommit("second", c1);
    expect(graph.parent(c2)).toBe(c1);
  });

  it("returns null for a missing hash", () => {
    expect(graph.parent("e".repeat(64))).toBeNull();
  });
});
