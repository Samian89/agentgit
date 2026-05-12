import BetterSqlite3 from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FIXTURE_DB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "index.db");

describe("fixture .agentgit/index.db", () => {
  it("fixture file exists on disk", () => {
    expect(existsSync(FIXTURE_DB)).toBe(true);
  });

  it("sessions table has at least one row", () => {
    const db = new BetterSqlite3(FIXTURE_DB, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number };
    db.close();
    expect(row.n).toBeGreaterThan(0);
  });

  it("commits table returns rows for a session", () => {
    const db = new BetterSqlite3(FIXTURE_DB, { readonly: true });
    const session = db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
    const commits = db
      .prepare("SELECT * FROM commits WHERE session_id = ? ORDER BY timestamp ASC")
      .all(session.id);
    db.close();
    expect(commits.length).toBeGreaterThan(0);
  });

  it("commits are parent-linked", () => {
    const db = new BetterSqlite3(FIXTURE_DB, { readonly: true });
    type Row = { hash: string; parent: string | null };
    const commits = db
      .prepare("SELECT hash, parent FROM commits ORDER BY timestamp ASC")
      .all() as Row[];
    db.close();
    expect(commits[0]?.parent).toBeNull();
    if (commits.length > 1) {
      expect(commits[1]?.parent).toBe(commits[0]?.hash);
    }
  });

  it("tree_entries are linked to commits", () => {
    const db = new BetterSqlite3(FIXTURE_DB, { readonly: true });
    const commit = db.prepare("SELECT tree FROM commits LIMIT 1").get() as { tree: string };
    const entries = db
      .prepare("SELECT * FROM tree_entries WHERE tree_hash = ?")
      .all(commit.tree);
    db.close();
    expect(entries.length).toBeGreaterThan(0);
  });
});
