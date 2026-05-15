import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  TARGET_VERSION,
  getCurrentVersion,
  migrationStatus,
  pendingMigrations,
  runMigrations,
} from "../migrations/index.js";

const V01_FIXTURE_DDL = MIGRATIONS[0]!.up;

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-mig-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openRaw(): Database.Database {
  const db = new Database(join(dir, "index.db"));
  db.pragma("foreign_keys = ON");
  return db;
}

describe("migrations runner", () => {
  it("treats an empty DB as version 0", () => {
    const db = openRaw();
    expect(getCurrentVersion(db)).toBe(0);
    db.close();
  });

  it("treats a v0.1 fixture (commits table, no schema_version) as version 1", () => {
    const db = openRaw();
    db.exec(V01_FIXTURE_DDL);
    expect(getCurrentVersion(db)).toBe(1);
    expect(pendingMigrations(db).map((m) => m.version)).toEqual([2, 3]);
    db.close();
  });

  it("upgrades a v0.1 fixture DB to TARGET_VERSION", () => {
    const db = openRaw();
    db.exec(V01_FIXTURE_DDL);
    const status = runMigrations(db);
    expect(status.current).toBe(TARGET_VERSION);
    expect(status.pending).toEqual([]);

    // schema_version has 1 (back-filled), 2, and 3 recorded.
    const rows = db
      .prepare(`SELECT version FROM schema_version ORDER BY version`)
      .all() as { version: number }[];
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);

    // commits has the new author/signature columns.
    const cols = (db.prepare(`PRAGMA table_info(commits)`).all() as {
      name: string;
    }[]).map((c) => c.name);
    for (const c of ["author_name", "author_email", "signature", "public_key"]) {
      expect(cols).toContain(c);
    }
    db.close();
  });

  it("normalizes a partial v0.1 fixture (missing indexes) before marking v1", () => {
    // Simulate a real-world v0.1 fixture that lacks some of the indexes added
    // in migration 001 — the runner must re-apply 001 idempotently so the
    // final schema matches a fresh v2 initialisation.
    const db = openRaw();
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        head TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE commits (
        hash TEXT PRIMARY KEY, tree TEXT NOT NULL, parent TEXT,
        session_id TEXT NOT NULL, timestamp INTEGER NOT NULL, message TEXT NOT NULL,
        tool_call TEXT, metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, mime_type TEXT, encoding TEXT NOT NULL DEFAULT 'base64');
      CREATE TABLE refs (name TEXT PRIMARY KEY, target TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'branch', updated_at INTEGER NOT NULL);
      CREATE TABLE tree_entries (tree_hash TEXT, path TEXT, blob_hash TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (tree_hash, path));
    `);
    // No indexes exist yet — the runner should add them.
    let indexNames = (db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]).map((r) => r.name);
    expect(indexNames).toEqual([]);

    runMigrations(db);
    indexNames = (db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]).map((r) => r.name);
    for (const expected of [
      "idx_sessions_status",
      "idx_sessions_created_at",
      "idx_commits_session_id",
      "idx_commits_parent",
      "idx_commits_timestamp",
      "idx_refs_target",
      "idx_refs_type",
      "idx_tree_entries_blob_hash",
    ]) {
      expect(indexNames).toContain(expected);
    }

    // v1, v2, and v3 are recorded in schema_version after normalization.
    const rows = db
      .prepare(`SELECT version FROM schema_version ORDER BY version`)
      .all() as { version: number }[];
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    db.close();
  });

  it("upgrades a fresh DB (version 0) to TARGET_VERSION", () => {
    const db = openRaw();
    const status = runMigrations(db);
    expect(status.current).toBe(TARGET_VERSION);
    expect(status.pending).toEqual([]);
    db.close();
  });

  it("is idempotent — second run does not apply more migrations", () => {
    const db = openRaw();
    runMigrations(db);
    const before = (db
      .prepare(`SELECT COUNT(*) AS n FROM schema_version`)
      .get() as { n: number }).n;
    runMigrations(db);
    const after = (db
      .prepare(`SELECT COUNT(*) AS n FROM schema_version`)
      .get() as { n: number }).n;
    expect(after).toBe(before);
    db.close();
  });

  it("refuses to open a DB with version higher than the bundled target", () => {
    const db = openRaw();
    runMigrations(db);
    // Pretend a newer build wrote a higher version.
    db.prepare(
      `INSERT INTO schema_version (version, name, applied_at) VALUES (?, 'future', ?)`,
    ).run(TARGET_VERSION + 5, Date.now());

    expect(() => runMigrations(db)).toThrow(/newer than the maximum/);
    db.close();
  });

  it("migrationStatus reports pending migrations on a v0.1 fixture", () => {
    const db = openRaw();
    db.exec(V01_FIXTURE_DDL);
    const status = migrationStatus(db);
    expect(status.current).toBe(1);
    expect(status.target).toBe(TARGET_VERSION);
    expect(status.pending.length).toBeGreaterThan(0);
    db.close();
  });

  it("normalized v0.1 fixture produces sqlite_master DDL identical to a fresh v2 install", () => {
    // Legacy fixture with stripped-down DDL: no FK constraints, no NOT NULL on
    // hash, no CHECK constraints — the minimal v0.1 schema that some real builds
    // shipped with.
    const legacyDb = openRaw();
    legacyDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        head TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE commits (
        hash TEXT PRIMARY KEY, tree TEXT NOT NULL, parent TEXT,
        session_id TEXT NOT NULL, timestamp INTEGER NOT NULL, message TEXT NOT NULL,
        tool_call TEXT, metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, mime_type TEXT, encoding TEXT NOT NULL DEFAULT 'base64');
      CREATE TABLE refs (name TEXT PRIMARY KEY, target TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'branch', updated_at INTEGER NOT NULL);
      CREATE TABLE tree_entries (tree_hash TEXT, path TEXT, blob_hash TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (tree_hash, path));
    `);
    runMigrations(legacyDb);

    // Fresh DB for comparison.
    const freshDir = join(tmpdir(), `agentgit-mig-fresh-${crypto.randomUUID()}`);
    mkdirSync(freshDir, { recursive: true });
    try {
      const freshDb = new Database(join(freshDir, "index.db"));
      freshDb.pragma("foreign_keys = ON");
      runMigrations(freshDb);

      const getTableSql = (db: Database.Database, name: string): string =>
        (
          db
            .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
            .get(name) as { sql: string }
        ).sql;

      for (const table of ["sessions", "commits", "blobs", "refs", "tree_entries"]) {
        expect(getTableSql(legacyDb, table)).toBe(getTableSql(freshDb, table));
      }
      freshDb.close();
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
    legacyDb.close();
  });
});
