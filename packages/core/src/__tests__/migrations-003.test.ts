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
  runMigrations,
} from "../migrations/index.js";
import { SqliteIndex } from "../sqlite-index.js";

const V2_FIXTURE_DDL = MIGRATIONS.slice(0, 2)
  .map((m) => m.up)
  .join("\n");

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-mig003-${crypto.randomUUID()}`);
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

describe("migration 003 (llm_call)", () => {
  it("TARGET_VERSION is 3 and migration 003 is registered", () => {
    expect(TARGET_VERSION).toBe(3);
    const names = MIGRATIONS.map((m) => m.name);
    expect(names).toContain("llm_call");
    expect(MIGRATIONS.find((m) => m.version === 3)?.name).toBe("llm_call");
  });

  it("applies cleanly to a v2 fixture and adds llm_call column", () => {
    const db = openRaw();
    // Build a v2 DB (migrations 1+2 only)
    db.exec(V2_FIXTURE_DDL);
    // Mark schema_version as v2 so runner sees current=2
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO schema_version (version, name, applied_at) VALUES (1, 'initial', ${Date.now()});
      INSERT OR IGNORE INTO schema_version (version, name, applied_at) VALUES (2, 'author_signature', ${Date.now()});
    `);
    expect(getCurrentVersion(db)).toBe(2);

    const status = runMigrations(db);
    expect(status.current).toBe(3);
    expect(status.target).toBe(3);
    expect(status.pending).toEqual([]);

    // Verify llm_call column now exists
    const cols = (db.prepare(`PRAGMA table_info(commits)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("llm_call");

    // schema_version has 3 recorded
    const versions = (
      db.prepare(`SELECT version FROM schema_version ORDER BY version`).all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    expect(versions).toContain(3);

    db.close();
  });

  it("SqliteIndex.init on a v2 fixture DB upgrades to v3 and exposes llm_call", () => {
    const dbPath = join(dir, "index.db");
    // Create v2 fixture on disk
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(V2_FIXTURE_DDL);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO schema_version (version, name, applied_at) VALUES (1, 'initial', ${Date.now()});
      INSERT OR IGNORE INTO schema_version (version, name, applied_at) VALUES (2, 'author_signature', ${Date.now()});
    `);
    db.close();

    // Opening via SqliteIndex must auto-run migrations to TARGET_VERSION=3
    const idx = SqliteIndex.init(dbPath);
    try {
      const st = idx.migrationStatus();
      expect(st.current).toBe(3);
      expect(st.target).toBe(3);

      // Column must be queryable (via PRAGMA on a fresh raw connection to the same file)
      const raw = Database(join(dir, "index.db"));
      try {
        const cols = (raw.prepare(`PRAGMA table_info(commits)`).all() as { name: string }[]).map(
          (c) => c.name,
        );
        expect(cols).toContain("llm_call");
      } finally {
        raw.close();
      }
    } finally {
      idx.close();
    }
  });

  it("rowToCommit synthesizes llmCall: null when reading a pre-003 row (defensive)", () => {
    const db = openRaw();
    db.exec(V2_FIXTURE_DDL);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO schema_version (version, name, applied_at) VALUES (1, 'initial', ${Date.now()});
      INSERT INTO schema_version (version, name, applied_at) VALUES (2, 'author_signature', ${Date.now()});
    `);
    // Insert a v2-shaped row (no llm_call column yet) — need a session for FK
    const hash = "a".repeat(64);
    const tree = "b".repeat(64);
    const now = Date.now();
    db.prepare(
      `INSERT INTO sessions (id, name, status, head, created_at, updated_at, metadata)
       VALUES (?, ?, 'active', NULL, ?, ?, '{}')`,
    ).run("sess-1", "legacy-sess", now, now);
    db.prepare(
      `INSERT INTO commits (hash, tree, parent, session_id, timestamp, message, tool_call, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(hash, tree, null, "sess-1", now, "legacy", null, "{}");

    // Now run migration 003
    runMigrations(db);

    // Re-open as index (it will see v3)
    const idx = new SqliteIndex(join(dir, "index.db"), null);
    try {
      const c = idx.getCommit(hash);
      expect(c).not.toBeNull();
      expect(c!.llmCall).toBeNull();
      expect(c!.toolCall).toBeNull();
      // column exists because migration ran
      const hasCol = idx
        .migrationStatus()
        .current === 3;
      expect(hasCol).toBe(true);
    } finally {
      idx.close();
    }
    db.close();
  });
});
