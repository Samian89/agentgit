import Database from "better-sqlite3";
import { MIGRATION_001_SQL } from "./001_initial.js";
import { MIGRATION_002_SQL } from "./002_author_signature.js";
import { MIGRATION_003_SQL } from "./003_llm_call.js";

export interface Migration {
  /** Monotonically increasing integer; must be unique within MIGRATIONS. */
  version: number;
  /** Short identifier, recorded in schema_version for audit. */
  name: string;
  /** SQL applied when migrating from version-1 → version. */
  up: string;
}

/**
 * Ordered list of migrations bundled with this build.
 *
 * The runner applies every migration whose version is greater than the DB's
 * current version. A DB whose version exceeds the highest entry here is
 * considered too new and the runner refuses to open it.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial", up: MIGRATION_001_SQL },
  { version: 2, name: "author_signature", up: MIGRATION_002_SQL },
  { version: 3, name: "llm_call", up: MIGRATION_003_SQL },
];

export const TARGET_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER NOT NULL PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
);
`;

// v1 tables in reverse FK dependency order (safe for DROP without FK violations).
const V1_TABLES = [
  "tree_entries",
  "refs",
  "blobs",
  "commits",
  "sessions",
] as const;
type V1Table = (typeof V1_TABLES)[number];

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return row !== undefined;
}

/**
 * Detect a DB's current schema version.
 *
 * - If the schema_version table exists and has rows, returns MAX(version).
 * - If schema_version is absent but the v0.1 'commits' table exists, returns 1
 *   (legacy v0.1 fixture — implicitly at version 1).
 * - Otherwise returns 0 (fresh DB).
 */
export function getCurrentVersion(db: Database.Database): number {
  if (tableExists(db, "schema_version")) {
    const row = db
      .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM schema_version`)
      .get() as { v: number };
    if (row.v > 0) return row.v;
    if (tableExists(db, "commits")) return 1;
    return 0;
  }
  if (tableExists(db, "commits")) return 1;
  return 0;
}

/** Return the migrations not yet applied to db, in ascending version order. */
export function pendingMigrations(db: Database.Database): Migration[] {
  const current = getCurrentVersion(db);
  return MIGRATIONS.filter((m) => m.version > current);
}

export interface MigrationStatus {
  current: number;
  target: number;
  pending: Migration[];
}

export function migrationStatus(db: Database.Database): MigrationStatus {
  return {
    current: getCurrentVersion(db),
    target: TARGET_VERSION,
    pending: pendingMigrations(db),
  };
}

/**
 * Open a raw better-sqlite3 connection without applying migrations. Used by
 * the `agentgit migrate --check` flow and by tests inspecting fixture DBs.
 */
export function openRawIndexDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Rebuild v0.1 tables to match the canonical v1 DDL.
 *
 * A real v0.1 database may have been created with a different CREATE TABLE
 * statement (e.g., missing FK constraints, missing NOT NULL, missing CHECK).
 * SQLite does not support ALTER TABLE to add constraints, so the only way to
 * produce a schema-identical DB is to snapshot the data, DROP the tables, and
 * re-run MIGRATION_001_SQL from scratch.
 *
 * PRAGMA foreign_keys must be OFF during the DROP; this function handles that
 * toggle itself and must be called outside any active transaction.
 */
function normalizeLegacyV01Schema(db: Database.Database): void {
  type Snapshot = { cols: string[]; rows: unknown[][] };
  const snapshots = new Map<V1Table, Snapshot>();

  // Snapshot all existing v1 table data before touching anything.
  for (const table of [...V1_TABLES].reverse()) {
    if (!tableExists(db, table)) continue;
    const cols = (
      db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
    ).map((r) => r.name);
    const rows = (
      db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]
    ).map((row) => cols.map((c) => row[c] ?? null));
    snapshots.set(table, { cols, rows });
  }

  // PRAGMA foreign_keys cannot be changed inside a transaction.
  db.pragma("foreign_keys = OFF");
  try {
    const rebuild = db.transaction(() => {
      // Drop tables in reverse FK order so no RESTRICT constraint fires.
      for (const table of V1_TABLES) {
        if (tableExists(db, table)) db.exec(`DROP TABLE "${table}"`);
      }

      // Recreate using the canonical v1 DDL (with all FK/CHECK/NOT NULL).
      db.exec(MIGRATIONS[0]!.up);

      // Re-insert snapshotted data, mapping old columns to canonical columns.
      for (const table of [...V1_TABLES].reverse()) {
        const snap = snapshots.get(table);
        if (!snap || snap.rows.length === 0) continue;
        const canonCols = (
          db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
        ).map((r) => r.name);
        const insertCols = snap.cols.filter((c) => canonCols.includes(c));
        if (insertCols.length === 0) continue;
        const ph = insertCols.map(() => "?").join(", ");
        const stmt = db.prepare(
          `INSERT INTO "${table}" (${insertCols.map((c) => `"${c}"`).join(", ")}) VALUES (${ph})`,
        );
        const idxMap = insertCols.map((c) => snap.cols.indexOf(c));
        for (const row of snap.rows) {
          stmt.run(idxMap.map((i) => row[i]));
        }
      }
    });
    rebuild();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/**
 * Apply pending migrations, advancing the DB to TARGET_VERSION.
 *
 * Throws if the DB version is higher than TARGET_VERSION (an older build is
 * trying to open a newer DB and refuses to do so).
 *
 * Legacy v0.1 fixtures are *normalized* before being marked v1: the runner
 * snapshots data, drops the old tables (with FK enforcement off), and
 * re-creates them from the canonical MIGRATION_001_SQL. This guarantees that
 * the resulting sqlite_master DDL is byte-identical to a fresh v2 install,
 * regardless of which v0.1 build originally created the database.
 */
export function runMigrations(db: Database.Database): MigrationStatus {
  db.exec(SCHEMA_VERSION_DDL);

  const current = getCurrentVersion(db);
  if (current > TARGET_VERSION) {
    throw new Error(
      `agentgit: database schema version ${current} is newer than the maximum version this build supports (${TARGET_VERSION}). Upgrade agentgit.`,
    );
  }

  const insert = db.prepare(
    `INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)`,
  );

  const v1Recorded =
    (db.prepare(`SELECT COUNT(*) AS n FROM schema_version WHERE version = 1`).get() as {
      n: number;
    }).n > 0;

  // Normalize legacy v0.1 fixtures BEFORE the transaction because
  // PRAGMA foreign_keys cannot be changed inside a transaction.
  if (current >= 1 && !v1Recorded) {
    normalizeLegacyV01Schema(db);
  }

  const apply = db.transaction(() => {
    if (current >= 1 && !v1Recorded) {
      insert.run(MIGRATIONS[0]!.version, MIGRATIONS[0]!.name, Date.now());
    }

    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      db.exec(m.up);
      insert.run(m.version, m.name, Date.now());
    }
  });
  apply();

  return {
    current: getCurrentVersion(db),
    target: TARGET_VERSION,
    pending: [],
  };
}
