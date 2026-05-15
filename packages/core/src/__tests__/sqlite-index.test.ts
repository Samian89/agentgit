import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteIndex } from "../sqlite-index.js";
import type { Blob, Commit, Ref, Session } from "../types.js";

const NOW = Date.now();
const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);
const TREE_HASH = "c".repeat(64);

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: crypto.randomUUID(),
    name: "test-session",
    status: "active",
    head: null,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
    ...overrides,
  };
}

function makeBlob(hash = HASH): Blob {
  return {
    hash,
    type: "blob",
    content: "hello",
    size: 5,
    encoding: "utf-8",
    mimeType: null,
  };
}

function makeCommit(sessionId: string, hash = HASH2, parent: string | null = null): Commit {
  return {
    hash,
    type: "commit",
    tree: TREE_HASH,
    parent,
    sessionId,
    timestamp: NOW,
    message: "test commit",
    toolCall: null,
    llmCall: null,
    metadata: {},
    author: null,
    signature: null,
    publicKey: null,
  };
}

let dir: string;
let idx: SqliteIndex;

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  idx = new SqliteIndex(join(dir, "index.db"));
});

afterEach(() => {
  idx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteIndex — schema migration", () => {
  it("applies schema on open without throwing", () => {
    // Constructor already applied it; re-opening the same DB should also be safe
    const idx2 = new SqliteIndex(join(dir, "index.db"));
    idx2.close();
  });
});

describe("SqliteIndex — sessions", () => {
  it("inserts and retrieves a session", () => {
    const s = makeSession();
    idx.insertSession(s);
    const got = idx.getSession(s.id);
    expect(got).toMatchObject({ id: s.id, name: s.name, status: "active", head: null });
  });

  it("returns null for an unknown session id", () => {
    expect(idx.getSession("nonexistent")).toBeNull();
  });

  it("updates session head", () => {
    const s = makeSession();
    idx.insertSession(s);
    // Need a commit to satisfy the FK before setting head
    const blob = makeBlob();
    idx.insertBlob(blob);
    const commit = makeCommit(s.id);
    idx.insertCommit(commit);
    idx.updateSessionHead(s.id, commit.hash, NOW + 1);
    expect(idx.getSession(s.id)?.head).toBe(commit.hash);
  });

  it("updates session status", () => {
    const s = makeSession();
    idx.insertSession(s);
    idx.updateSessionStatus(s.id, "completed", NOW + 1);
    expect(idx.getSession(s.id)?.status).toBe("completed");
  });

  it("lists sessions in descending creation order", () => {
    const s1 = makeSession({ id: crypto.randomUUID(), name: "first", createdAt: NOW });
    const s2 = makeSession({ id: crypto.randomUUID(), name: "second", createdAt: NOW + 1000 });
    idx.insertSession(s1);
    idx.insertSession(s2);
    const list = idx.listSessions();
    expect(list[0]?.name).toBe("second");
    expect(list[1]?.name).toBe("first");
  });
});

describe("SqliteIndex — blobs", () => {
  it("inserts a blob and reports hasBlob = true", () => {
    const blob = makeBlob();
    idx.insertBlob(blob);
    expect(idx.hasBlob(blob.hash)).toBe(true);
  });

  it("hasBlob returns false for unknown hashes", () => {
    expect(idx.hasBlob("d".repeat(64))).toBe(false);
  });

  it("INSERT OR IGNORE is idempotent", () => {
    const blob = makeBlob();
    idx.insertBlob(blob);
    expect(() => idx.insertBlob(blob)).not.toThrow();
  });

  it("getBlob returns metadata without content", () => {
    const blob = makeBlob();
    idx.insertBlob(blob);
    const got = idx.getBlob(blob.hash);
    expect(got).toMatchObject({ hash: blob.hash, size: 5, encoding: "utf-8", mimeType: null });
  });
});

describe("SqliteIndex — commits", () => {
  let sessionId: string;

  beforeEach(() => {
    const s = makeSession();
    sessionId = s.id;
    idx.insertSession(s);
    idx.insertBlob(makeBlob());
  });

  it("inserts and retrieves a commit", () => {
    const commit = makeCommit(sessionId);
    idx.insertCommit(commit);
    const got = idx.getCommit(commit.hash);
    expect(got).toMatchObject({ hash: commit.hash, sessionId, message: "test commit" });
  });

  it("returns null for unknown hash", () => {
    expect(idx.getCommit("e".repeat(64))).toBeNull();
  });

  it("getCommitsBySession returns commits for the session", () => {
    const c1 = makeCommit(sessionId, "a".repeat(64));
    const c2 = makeCommit(sessionId, "b".repeat(64), "a".repeat(64));
    idx.insertCommit(c1);
    idx.insertCommit(c2);
    const commits = idx.getCommitsBySession(sessionId);
    expect(commits).toHaveLength(2);
  });

  it("getCommitsBySession returns [] for unknown session", () => {
    expect(idx.getCommitsBySession("no-such-session")).toEqual([]);
  });
});

describe("SqliteIndex — tree entries", () => {
  beforeEach(() => {
    idx.insertBlob(makeBlob());
  });

  it("inserts and retrieves tree entries", () => {
    idx.insertTreeEntries(TREE_HASH, [
      { path: "files/main.py", blobHash: HASH, size: 5 },
    ]);
    const entries = idx.getTreeEntries(TREE_HASH);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: "files/main.py", blobHash: HASH, size: 5 });
  });

  it("returns [] for an unknown tree hash", () => {
    expect(idx.getTreeEntries("0".repeat(64))).toEqual([]);
  });
});

describe("SqliteIndex — refs", () => {
  let sessionId: string;

  beforeEach(() => {
    const s = makeSession();
    sessionId = s.id;
    idx.insertSession(s);
    idx.insertBlob(makeBlob());
    idx.insertCommit(makeCommit(sessionId));
  });

  it("upserts and retrieves a ref", () => {
    const ref: Ref = { name: "sessions/main", target: HASH2, type: "branch", updatedAt: NOW };
    idx.upsertRef(ref);
    const got = idx.getRef("sessions/main");
    expect(got).toMatchObject({ name: "sessions/main", target: HASH2, type: "branch" });
  });

  it("upsertRef updates an existing ref", () => {
    const ref: Ref = { name: "sessions/main", target: HASH2, type: "branch", updatedAt: NOW };
    idx.upsertRef(ref);
    idx.upsertRef({ ...ref, updatedAt: NOW + 1 });
    expect(idx.getRef("sessions/main")?.updatedAt).toBe(NOW + 1);
  });

  it("listRefs returns all refs", () => {
    idx.upsertRef({ name: "sessions/a", target: HASH2, type: "session-head", updatedAt: NOW });
    idx.upsertRef({ name: "tags/v1", target: HASH2, type: "tag", updatedAt: NOW });
    expect(idx.listRefs()).toHaveLength(2);
  });

  it("listRefs filters by type", () => {
    idx.upsertRef({ name: "sessions/a", target: HASH2, type: "session-head", updatedAt: NOW });
    idx.upsertRef({ name: "tags/v1", target: HASH2, type: "tag", updatedAt: NOW });
    expect(idx.listRefs("tag")).toHaveLength(1);
  });

  it("deleteRef removes the ref", () => {
    idx.upsertRef({ name: "sessions/main", target: HASH2, type: "branch", updatedAt: NOW });
    idx.deleteRef("sessions/main");
    expect(idx.getRef("sessions/main")).toBeNull();
  });
});

describe("SqliteIndex — transaction", () => {
  it("rolls back all changes if the function throws", () => {
    const s = makeSession();
    expect(() => {
      idx.transaction(() => {
        idx.insertSession(s);
        throw new Error("abort");
      });
    }).toThrow("abort");
    expect(idx.getSession(s.id)).toBeNull();
  });

  it("commits all changes when the function succeeds", () => {
    const s = makeSession();
    idx.transaction(() => {
      idx.insertSession(s);
    });
    expect(idx.getSession(s.id)).not.toBeNull();
  });
});
