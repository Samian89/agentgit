import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repository } from "../repository.js";
import { canonicalJson } from "../hash.js";
import { gc, reachableObjects } from "../gc.js";

let dir: string;
let repo: Repository;

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-gc-${crypto.randomUUID()}`);
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

/**
 * Write a synthetic object file that no commit references. Returns its hash.
 * Uses ObjectStore.write so the file ends up at the canonical sharded path,
 * then optionally orphans it by skipping the index entry.
 */
function writeOrphanBlob(content: string): string {
  return repo.objects.write({
    type: "blob",
    content,
    size: Buffer.byteLength(content, "utf8"),
    encoding: "utf-8",
    mimeType: null,
  });
}

function objectFile(agentgitDir: string, hash: string): string {
  return join(agentgitDir, "objects", hash.slice(0, 2), hash.slice(2));
}

function gcFile(agentgitDir: string, hash: string): string {
  return join(agentgitDir, "objects.gc", hash.slice(0, 2), hash.slice(2));
}

describe("reachableObjects", () => {
  it("includes commits, their trees, blobs, and parent commits", () => {
    const session = repo.createSession("s1");
    const c1 = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hello" }],
    });
    const c2 = repo.commit({
      sessionId: session.id,
      message: "c2",
      stateEntries: [{ path: "b.txt", content: "world" }],
    });
    repo.updateSessionStatus(session.id, "completed");

    const reachable = reachableObjects(repo);
    expect(reachable.has(c1.hash)).toBe(true);
    expect(reachable.has(c2.hash)).toBe(true);
    expect(reachable.has(c1.tree)).toBe(true);
    expect(reachable.has(c2.tree)).toBe(true);
  });
});

describe("gc — soft delete", () => {
  it("soft-deletes orphan blob files; reachable objects untouched; refs still resolve", () => {
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "real",
      stateEntries: [{ path: "real.txt", content: "real-content" }],
    });
    repo.createBranch("main", commit.hash);
    repo.updateSessionStatus(session.id, "completed");

    const orphan = writeOrphanBlob("orphan-content");
    expect(existsSync(objectFile(repo.agentgitDir, orphan))).toBe(true);

    const result = repo.gc();
    expect(result.refusedActiveSessions).toBeNull();
    expect(result.softDeleted).toContain(orphan);
    expect(existsSync(objectFile(repo.agentgitDir, orphan))).toBe(false);
    expect(existsSync(gcFile(repo.agentgitDir, orphan))).toBe(true);

    // Reachable objects survived.
    expect(existsSync(objectFile(repo.agentgitDir, commit.hash))).toBe(true);
    expect(existsSync(objectFile(repo.agentgitDir, commit.tree))).toBe(true);

    // Ref still resolves to the same commit.
    expect(repo.getBranch("main")).toBe(commit.hash);
  });

  it("refuses to run when an active session exists and no --force", () => {
    const session = repo.createSession("active");
    repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "f.txt", content: "x" }],
    });
    const orphan = writeOrphanBlob("orphan");

    const result = repo.gc();
    expect(result.refusedActiveSessions).toEqual([session.id]);
    expect(result.softDeleted).toHaveLength(0);
    // Orphan untouched because gc bailed out.
    expect(existsSync(objectFile(repo.agentgitDir, orphan))).toBe(true);

    const forced = repo.gc({ force: true });
    expect(forced.refusedActiveSessions).toBeNull();
    expect(forced.softDeleted).toContain(orphan);
  });

  it("dry-run makes no filesystem changes", () => {
    const session = repo.createSession("s1");
    repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "x.txt", content: "x" }],
    });
    repo.updateSessionStatus(session.id, "completed");
    const orphan = writeOrphanBlob("orphan");

    const result = repo.gc({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.softDeleted).toContain(orphan);
    expect(existsSync(objectFile(repo.agentgitDir, orphan))).toBe(true);
    expect(existsSync(gcFile(repo.agentgitDir, orphan))).toBe(false);
  });
});

describe("gc — hard delete (prune)", () => {
  it("--prune-older-than=0 hard-deletes everything currently soft-deleted", () => {
    const session = repo.createSession("s1");
    repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "f.txt", content: "f" }],
    });
    repo.updateSessionStatus(session.id, "completed");

    const orphan1 = writeOrphanBlob("orphan-1");
    const orphan2 = writeOrphanBlob("orphan-2");

    const first = repo.gc();
    expect(first.softDeleted.sort()).toEqual([orphan1, orphan2].sort());
    expect(existsSync(gcFile(repo.agentgitDir, orphan1))).toBe(true);
    expect(existsSync(gcFile(repo.agentgitDir, orphan2))).toBe(true);

    // Bump the clock by 1ms so the cutoff comparison includes both entries
    // (deletedAt <= now - 0 only matches when now is strictly later).
    const second = repo.gc({
      pruneOlderThanMs: 0,
      now: Date.now() + 1000,
    });
    expect(second.hardDeleted.sort()).toEqual([orphan1, orphan2].sort());
    expect(existsSync(gcFile(repo.agentgitDir, orphan1))).toBe(false);
    expect(existsSync(gcFile(repo.agentgitDir, orphan2))).toBe(false);

    // Manifest emptied.
    const manifest = join(repo.agentgitDir, "objects.gc", "manifest.jsonl");
    expect(readFileSync(manifest, "utf8")).toBe("");
  });

  it("respects pruneOlderThanMs cutoff and leaves recent entries alone", () => {
    const session = repo.createSession("s1");
    repo.commit({ sessionId: session.id, message: "c" });
    repo.updateSessionStatus(session.id, "completed");

    const orphan = writeOrphanBlob("orphan");
    const t0 = 1_000_000_000_000;
    repo.gc({ now: t0 });
    expect(existsSync(gcFile(repo.agentgitDir, orphan))).toBe(true);

    // Only 5 minutes later with a 30-day cutoff → still soft-deleted.
    const result = repo.gc({
      now: t0 + 5 * 60 * 1000,
      pruneOlderThanMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(result.hardDeleted).toHaveLength(0);
    expect(existsSync(gcFile(repo.agentgitDir, orphan))).toBe(true);
  });
});
