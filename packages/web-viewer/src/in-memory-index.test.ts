import { describe, expect, it } from "vitest";
import { InMemoryIndex } from "./in-memory-index.js";
import type { BundleContents } from "./bundle/unpack.js";
import type {
  BundleManifest,
  Commit,
  Session,
  TreeEntry,
} from "./bundle/types.js";

function makeCommit(overrides: Partial<Commit> & Pick<Commit, "hash">): Commit {
  return {
    hash: overrides.hash,
    type: "commit",
    tree: overrides.tree ?? "tree-" + overrides.hash,
    parent: overrides.parent ?? null,
    sessionId: overrides.sessionId ?? "s1",
    timestamp: overrides.timestamp ?? 1_000,
    message: overrides.message ?? "msg-" + overrides.hash,
    toolCall: overrides.toolCall ?? null,
    llmCall: overrides.llmCall ?? null,
    metadata: overrides.metadata ?? {},
    author: overrides.author ?? null,
    signature: overrides.signature ?? null,
    publicKey: overrides.publicKey ?? null,
  };
}

function makeSession(overrides: Partial<Session> & Pick<Session, "id">): Session {
  return {
    id: overrides.id,
    name: overrides.name ?? "Session " + overrides.id,
    createdAt: overrides.createdAt ?? 100,
    updatedAt: overrides.updatedAt ?? 200,
    head: overrides.head ?? null,
    status: overrides.status ?? "active",
    metadata: overrides.metadata ?? {},
  };
}

function makeBundle(args: {
  commits: Commit[];
  sessions: Session[];
  trees: Record<string, TreeEntry[]>;
}): BundleContents {
  const manifest: BundleManifest = {
    formatVersion: 1,
    schemaVersion: 1,
    sessionIds: args.sessions.map((s) => s.id),
    createdAt: 0,
    generator: "test",
  };
  const objects = new Map<string, Record<string, unknown>>();
  for (const [hash, entries] of Object.entries(args.trees)) {
    objects.set(hash, { type: "tree", entries });
  }
  for (const c of args.commits) {
    objects.set(c.hash, c as unknown as Record<string, unknown>);
  }
  return {
    manifest,
    objects,
    commits: args.commits,
    refs: [],
    sessions: args.sessions,
  };
}

describe("InMemoryIndex", () => {
  it("returns generator from manifest", () => {
    const bundle = makeBundle({ commits: [], sessions: [], trees: {} });
    bundle.manifest.generator = "agentgit-cli/1.0";
    const idx = new InMemoryIndex(bundle);
    expect(idx.generator()).toBe("agentgit-cli/1.0");
  });

  it("returns sessions newest-first as SessionRow shape", () => {
    const bundle = makeBundle({
      commits: [],
      sessions: [
        makeSession({ id: "old", createdAt: 100 }),
        makeSession({ id: "new", createdAt: 999 }),
      ],
      trees: {},
    });
    const rows = new InMemoryIndex(bundle).getSessions();
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(rows[0]).toMatchObject({
      id: "new",
      created_at: 999,
      updated_at: 200,
    });
    expect(typeof rows[0]!.metadata).toBe("string");
  });

  it("returns commits for a session sorted by timestamp ascending", () => {
    const c1 = makeCommit({ hash: "c1", sessionId: "s1", timestamp: 10 });
    const c2 = makeCommit({ hash: "c2", sessionId: "s1", timestamp: 30 });
    const c3 = makeCommit({ hash: "c3", sessionId: "s1", timestamp: 20 });
    const cOther = makeCommit({ hash: "co", sessionId: "s2", timestamp: 5 });
    const bundle = makeBundle({
      commits: [c2, c1, c3, cOther],
      sessions: [makeSession({ id: "s1" }), makeSession({ id: "s2" })],
      trees: {},
    });
    const rows = new InMemoryIndex(bundle).getCommits("s1");
    expect(rows.map((r) => r.hash)).toEqual(["c1", "c3", "c2"]);
    expect(rows[0]).toMatchObject({
      hash: "c1",
      session_id: "s1",
      message: "msg-c1",
      tool_call: null,
    });
  });

  it("returns empty commits for unknown session id", () => {
    const bundle = makeBundle({ commits: [], sessions: [], trees: {} });
    expect(new InMemoryIndex(bundle).getCommits("nope")).toEqual([]);
  });

  it("computes diff: added, removed, modified between two commit trees", () => {
    const c1 = makeCommit({ hash: "c1", tree: "t1" });
    const c2 = makeCommit({ hash: "c2", tree: "t2" });
    const bundle = makeBundle({
      commits: [c1, c2],
      sessions: [makeSession({ id: "s1" })],
      trees: {
        t1: [
          { path: "a.txt", blobHash: "blob-a-v1", size: 1 },
          { path: "b.txt", blobHash: "blob-b", size: 1 },
        ],
        t2: [
          { path: "a.txt", blobHash: "blob-a-v2", size: 1 },
          { path: "c.txt", blobHash: "blob-c", size: 1 },
        ],
      },
    });
    const diff = new InMemoryIndex(bundle).getDiff("c1", "c2");
    expect(diff.added).toEqual([
      { path: "c.txt", from_hash: null, to_hash: "blob-c" },
    ]);
    expect(diff.removed).toEqual([
      { path: "b.txt", from_hash: "blob-b", to_hash: null },
    ]);
    expect(diff.modified).toEqual([
      { path: "a.txt", from_hash: "blob-a-v1", to_hash: "blob-a-v2" },
    ]);
    expect(diff.hash1).toBe("c1");
    expect(diff.hash2).toBe("c2");
    expect(diff.commit1_tool_call).toBeNull();
    expect(diff.commit2_tool_call).toBeNull();
  });

  it("serialises tool_call on diff when present on commits", () => {
    const toolCall = {
      id: "t",
      name: "Write",
      input: { path: "x" },
      output: null,
      startedAt: 0,
      completedAt: null,
      status: "pending" as const,
      error: null,
    };
    const c1 = makeCommit({ hash: "c1", tree: "t1", toolCall });
    const c2 = makeCommit({ hash: "c2", tree: "t2", toolCall });
    const bundle = makeBundle({
      commits: [c1, c2],
      sessions: [makeSession({ id: "s1" })],
      trees: { t1: [], t2: [] },
    });
    const diff = new InMemoryIndex(bundle).getDiff("c1", "c2");
    expect(diff.commit1_tool_call).toBe(JSON.stringify(toolCall));
    expect(diff.commit2_tool_call).toBe(JSON.stringify(toolCall));
  });

  it("returns empty diff entries for unknown commits", () => {
    const bundle = makeBundle({ commits: [], sessions: [], trees: {} });
    const diff = new InMemoryIndex(bundle).getDiff("missing1", "missing2");
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it("blames each path to the last commit that changed its blob", () => {
    const c1 = makeCommit({
      hash: "c1",
      tree: "t1",
      sessionId: "s1",
      timestamp: 10,
      message: "add a and b",
    });
    const c2 = makeCommit({
      hash: "c2",
      tree: "t2",
      sessionId: "s1",
      timestamp: 20,
      message: "modify a",
    });
    const c3 = makeCommit({
      hash: "c3",
      tree: "t3",
      sessionId: "s1",
      timestamp: 30,
      message: "unchanged",
    });
    const bundle = makeBundle({
      commits: [c1, c2, c3],
      sessions: [makeSession({ id: "s1" })],
      trees: {
        t1: [
          { path: "a.txt", blobHash: "blob-a-v1", size: 1 },
          { path: "b.txt", blobHash: "blob-b", size: 1 },
        ],
        t2: [
          { path: "a.txt", blobHash: "blob-a-v2", size: 1 },
          { path: "b.txt", blobHash: "blob-b", size: 1 },
        ],
        t3: [
          { path: "a.txt", blobHash: "blob-a-v2", size: 1 },
          { path: "b.txt", blobHash: "blob-b", size: 1 },
        ],
      },
    });
    const blame = new InMemoryIndex(bundle).getBlame("s1");
    const byPath = Object.fromEntries(blame.map((b) => [b.path, b]));
    expect(byPath["a.txt"]).toMatchObject({
      commit_hash: "c2",
      timestamp: 20,
      message: "modify a",
    });
    expect(byPath["b.txt"]).toMatchObject({
      commit_hash: "c1",
      timestamp: 10,
      message: "add a and b",
    });
    expect(blame.map((b) => b.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("returns empty blame for unknown session", () => {
    const bundle = makeBundle({ commits: [], sessions: [], trees: {} });
    expect(new InMemoryIndex(bundle).getBlame("nope")).toEqual([]);
  });
});
