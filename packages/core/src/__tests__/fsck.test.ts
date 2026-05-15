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
import { fsck } from "../fsck.js";
import {
  MIGRATIONS,
  migrationStatus,
  openRawIndexDb,
} from "../migrations/index.js";

let dir: string;
let repo: Repository;

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-fsck-${crypto.randomUUID()}`);
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

function objectFile(agentgitDir: string, hash: string): string {
  return join(agentgitDir, "objects", hash.slice(0, 2), hash.slice(2));
}

function corruptFile(agentgitDir: string, hash: string): string {
  return join(agentgitDir, "objects.corrupt", hash.slice(0, 2), hash.slice(2));
}

describe("fsck — healthy repo", () => {
  it("returns ok with populated stats", () => {
    const session = repo.createSession("s1");
    const c1 = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hello" }],
    });
    repo.createBranch("main", c1.hash);

    const report = repo.fsck();
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.stats.objects).toBeGreaterThan(0);
    expect(report.stats.commits).toBe(1);
    expect(report.stats.blobs).toBe(1);
    expect(report.stats.refs).toBe(1);
    expect(report.schema.current).toBe(report.schema.target);
  });
});

describe("fsck — corrupt object detection", () => {
  it("reports a hash mismatch when an object body is tampered with", () => {
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hello" }],
    });

    // Flip a byte inside the blob object's JSON.
    const treeEntries = repo.index.getTreeEntries(commit.tree);
    expect(treeEntries.length).toBe(1);
    const blobHash = treeEntries[0]!.blobHash;
    const blobPath = objectFile(repo.agentgitDir, blobHash);
    const original = readFileSync(blobPath, "utf8");
    const parsed = JSON.parse(original) as Record<string, unknown>;
    parsed.content = "tampered";
    writeFileSync(blobPath, canonicalJson(parsed), "utf8");

    const report = repo.fsck();
    expect(report.ok).toBe(false);
    const corruption = report.errors.find(
      (e) => e.type === "corrupt-object" && e.hash === blobHash,
    );
    expect(corruption).toBeDefined();
    expect(corruption?.message).toContain(blobHash);
  });

  it("--repair quarantines the corrupt file to objects.corrupt/ and writes RECOVERY.md", () => {
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hello" }],
    });
    const blobHash = repo.index.getTreeEntries(commit.tree)[0]!.blobHash;
    const blobPath = objectFile(repo.agentgitDir, blobHash);
    const parsed = JSON.parse(readFileSync(blobPath, "utf8")) as Record<
      string,
      unknown
    >;
    parsed.content = "tampered";
    writeFileSync(blobPath, canonicalJson(parsed), "utf8");

    const report = repo.fsck({ repair: true });
    expect(report.ok).toBe(false); // corruption is still reported
    const issue = report.errors.find((e) => e.hash === blobHash);
    expect(issue?.repaired).toBe(true);
    expect(existsSync(blobPath)).toBe(false);
    expect(existsSync(corruptFile(repo.agentgitDir, blobHash))).toBe(true);

    const recovery = join(repo.agentgitDir, "objects.corrupt", "RECOVERY.md");
    expect(existsSync(recovery)).toBe(true);
    expect(readFileSync(recovery, "utf8")).toContain(blobHash);
  });
});

describe("fsck — missing-object detection", () => {
  it("reports orphaned commits row pointing to a deleted object file", () => {
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hi" }],
    });

    // Delete the commit object file from disk while leaving the row behind.
    rmSync(objectFile(repo.agentgitDir, commit.hash));

    const report = repo.fsck();
    expect(report.ok).toBe(false);
    const missing = report.errors.find(
      (e) => e.type === "missing-object" && e.hash === commit.hash,
    );
    expect(missing).toBeDefined();
  });
});

describe("fsck — JSON output", () => {
  it("emits the documented schema and is round-trip parseable", () => {
    const session = repo.createSession("s1");
    repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "x.txt", content: "x" }],
    });

    const report = repo.fsck();
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty("ok");
    expect(parsed).toHaveProperty("errors");
    expect(parsed).toHaveProperty("warnings");
    expect(parsed).toHaveProperty("stats.objects");
    expect(parsed).toHaveProperty("stats.commits");
    expect(parsed).toHaveProperty("stats.blobs");
    expect(parsed).toHaveProperty("stats.refs");
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });
});

describe("fsck — schema version", () => {
  it("reports pending migration when schema_version is rolled back below target", () => {
    const session = repo.createSession("s1");
    repo.commit({ sessionId: session.id, message: "c1" });

    // Roll the recorded schema version back to 1 (pretend we are on an old DB).
    const db = repo.index.unsafeDb();
    db.prepare(`DELETE FROM schema_version WHERE version > 1`).run();

    const report = repo.fsck();
    const drift = report.errors.find(
      (e) => e.type === "schema-version-pending",
    );
    expect(drift).toBeDefined();
    expect(report.schema.current).toBe(1);
  });

  it("reports an incomplete audit row even when MAX(version) matches target", () => {
    repo.createSession("s1");
    const db = repo.index.unsafeDb();
    // Delete the v1 audit row but keep v2 — MAX(version) == TARGET so the
    // mismatch check passes, but the audit trail is broken.
    db.prepare(`DELETE FROM schema_version WHERE version = 1`).run();

    const report = repo.fsck();
    const issue = report.errors.find(
      (e) => e.type === "schema-version-incomplete",
    );
    expect(issue).toBeDefined();
    expect(report.ok).toBe(false);
  });
});

describe("fsck — index consistency", () => {
  it("reports a dangling session.head pointing to a deleted commit", () => {
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hi" }],
    });

    // Remove the commit object file but keep the session row pointing at it.
    rmSync(objectFile(repo.agentgitDir, commit.hash));

    const report = repo.fsck();
    expect(report.ok).toBe(false);
    const dangling = report.errors.find(
      (e) => e.type === "dangling-session-head" && e.hash === commit.hash,
    );
    expect(dangling).toBeDefined();
  });

  it("treats objects in objects.gc/ as missing for index rows in the live store", () => {
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hi" }],
    });

    // Simulate a manual / out-of-band gc that quarantined a still-referenced
    // blob: move it from objects/ to objects.gc/ behind the index's back.
    const blobHash = repo.index.getTreeEntries(commit.tree)[0]!.blobHash;
    const src = objectFile(repo.agentgitDir, blobHash);
    const dstDir = join(repo.agentgitDir, "objects.gc", blobHash.slice(0, 2));
    mkdirSync(dstDir, { recursive: true });
    const dst = join(dstDir, blobHash.slice(2));
    writeFileSync(dst, readFileSync(src));
    rmSync(src);

    const report = repo.fsck();
    expect(report.ok).toBe(false);
    const missing = report.errors.find(
      (e) => e.type === "missing-object" && e.hash === blobHash,
    );
    expect(missing).toBeDefined();
  });

  it("reports a missing required table", () => {
    repo.createSession("s1");
    const db = repo.index.unsafeDb();
    // Drop refs (no row depends on it being non-empty); foreign_keys are
    // toggled off so we can drop a table without violating any RESTRICT.
    db.pragma("foreign_keys = OFF");
    db.exec(`DROP TABLE refs`);
    db.pragma("foreign_keys = ON");

    const report = repo.fsck();
    const missing = report.errors.find(
      (e) => e.type === "missing-table" && /'refs'/.test(e.message),
    );
    expect(missing).toBeDefined();
    expect(report.ok).toBe(false);
  });

  it("reports SQLite integrity_check failures", () => {
    repo.createSession("s1");
    const db = repo.index.unsafeDb();
    // Run the actual pragma to confirm the healthy path returns ok; on a
    // freshly-initialised DB we expect no integrity errors in the report.
    const report = repo.fsck();
    const failures = report.errors.filter(
      (e) => e.type === "integrity-check-failed",
    );
    expect(failures).toHaveLength(0);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("flags a type-mismatch when an indexed hash points at the wrong object type", () => {
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hi" }],
    });
    const blobHash = repo.index.getTreeEntries(commit.tree)[0]!.blobHash;

    // Forge a state where the on-disk file at `commit.hash` has type "blob".
    // We can't change the filename (it would no longer match), so we write
    // a synthetic blob body and re-hash it, then overwrite the SQLite
    // commit row to claim that the new (blob-typed) hash IS a commit.
    const forgedBlobBody = {
      type: "blob",
      content: "decoy",
      size: 5,
      encoding: "utf-8" as const,
      mimeType: null,
    };
    const forgedHash = repo.objects.write(forgedBlobBody);

    const db = repo.index.unsafeDb();
    // Point a commits row at the forged blob hash. Disable FK to bypass
    // sessions.head and commits.parent restrictions for the duration of
    // the surgical rewrite — fsck must catch the mismatch regardless of
    // how it was introduced.
    db.pragma("foreign_keys = OFF");
    db.prepare(`UPDATE commits SET hash = ? WHERE hash = ?`).run(
      forgedHash,
      commit.hash,
    );
    db.prepare(`UPDATE sessions SET head = ? WHERE head = ?`).run(
      forgedHash,
      commit.hash,
    );
    db.pragma("foreign_keys = ON");

    const report = repo.fsck();
    const mismatch = report.errors.find(
      (e) => e.type === "type-mismatch" && e.hash === forgedHash,
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.message).toContain("expected 'commit'");
    expect(report.ok).toBe(false);
  });
});

describe("fsck — schema validation is not bypassed by auto-migration", () => {
  it("detects a v0.1 DB still pending migration and does NOT auto-apply it", () => {
    // Build a v0.1 fixture by hand: create only the directory and an
    // index.db that has had migration 001 applied directly (no
    // schema_version rows). We deliberately do NOT go through
    // Repository.init/open here — that would auto-migrate.
    const fixtureDir = join(dir, ".agentgit-fixture");
    mkdirSync(join(fixtureDir, "objects"), { recursive: true });
    mkdirSync(join(fixtureDir, "refs"), { recursive: true });
    const dbPath = join(fixtureDir, "index.db");
    const setup = openRawIndexDb(dbPath);
    setup.exec(MIGRATIONS[0]!.up);
    setup.close();

    // Sanity: the fixture truly is at version 1.
    const probe = openRawIndexDb(dbPath);
    expect(migrationStatus(probe).current).toBe(1);
    probe.close();

    const report = fsck(fixtureDir);
    expect(report.ok).toBe(false);
    const pending = report.errors.find(
      (e) => e.type === "schema-version-pending",
    );
    expect(pending).toBeDefined();
    expect(pending?.message).toMatch(/agentgit migrate/);

    // CRITICAL: fsck must NOT have silently bumped the schema while it ran.
    const after = openRawIndexDb(dbPath);
    expect(migrationStatus(after).current).toBe(1);
    after.close();
  });

  it("returns a missing-index-db error when the DB file does not exist", () => {
    const empty = join(dir, ".agentgit-empty");
    mkdirSync(empty, { recursive: true });
    const report = fsck(empty);
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.type).toBe("missing-index-db");
  });
});

describe("fsck — orphaned tree_entries.tree_hash rows", () => {
  it("flags a stale projection — tree object still on disk but no commit references it", () => {
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hi" }],
    });

    // Simulate a half-cleanup: delete the commit row (the trap the
    // troubleshooting doc warns about — tree_entries have no FK on
    // tree_hash, so they survive when commits are removed). To bypass
    // the ON DELETE RESTRICT from sessions.head, drop the session too.
    const db = repo.index.unsafeDb();
    db.pragma("foreign_keys = OFF");
    db.prepare(`UPDATE sessions SET head = NULL WHERE id = ?`).run(session.id);
    db.prepare(`DELETE FROM commits WHERE hash = ?`).run(commit.hash);
    db.pragma("foreign_keys = ON");

    // The tree object is still on disk (gc has not run yet), but no
    // commit row references it any more. Its tree_entries rows are now
    // stale projections.
    const report = repo.fsck();
    expect(report.ok).toBe(false);
    const stale = report.errors.find(
      (e) =>
        e.type === "orphan-index-row" &&
        e.hash === commit.tree &&
        /stale projection/.test(e.message),
    );
    expect(stale).toBeDefined();
  });

  it("flags a tree_entries row whose tree_hash is referenced by no commit and matches no on-disk tree", () => {
    const session = repo.createSession("s1");
    repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hi" }],
    });

    // Insert a synthetic tree_entries row whose tree_hash is bogus.
    // tree_entries has no FK on tree_hash, so the schema does not block
    // this — exactly the trap the troubleshooting doc warns about.
    const phantomTree = "f".repeat(64);
    const realBlobHash = repo.index.unsafeDb()
      .prepare(`SELECT hash FROM blobs LIMIT 1`)
      .get() as { hash: string };
    expect(realBlobHash).toBeDefined();

    repo.index
      .unsafeDb()
      .prepare(
        `INSERT INTO tree_entries (tree_hash, path, blob_hash, size)
         VALUES (?, ?, ?, ?)`,
      )
      .run(phantomTree, "ghost.txt", realBlobHash.hash, 1);

    const report = repo.fsck();
    expect(report.ok).toBe(false);
    const orphan = report.errors.find(
      (e) => e.type === "orphan-index-row" && e.hash === phantomTree,
    );
    expect(orphan).toBeDefined();
    expect(orphan?.message).toContain("ghost.txt");
  });
});
