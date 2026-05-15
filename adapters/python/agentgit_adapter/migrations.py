"""AgentGit schema migrations for the Python adapter.

This module is the byte-for-byte mirror of ``packages/core/src/migrations/``
in the TypeScript core. Both sides must apply identical SQL so that a repo
initialised by either implementation produces the same ``sqlite_master``
dump after migrating to the target version.

Acceptance criterion: ``agentgit migrate --check`` and ``run_migrations`` must
agree on the current schema version; a v0.1 fixture DB (one that has a
``commits`` table but no ``schema_version`` table) is implicitly at version 1.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional


# Migration 001 mirrors packages/core/src/migrations/001_initial.ts.
MIGRATION_001_SQL = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT    NOT NULL PRIMARY KEY,
    name        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'completed', 'failed', 'abandoned')),
    head        TEXT    REFERENCES commits(hash) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    metadata    TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sessions_status     ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);

CREATE TABLE IF NOT EXISTS commits (
    hash        TEXT    NOT NULL PRIMARY KEY,
    tree        TEXT    NOT NULL,
    parent      TEXT    REFERENCES commits(hash) ON DELETE RESTRICT,
    session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    timestamp   INTEGER NOT NULL,
    message     TEXT    NOT NULL,
    tool_call   TEXT,
    metadata    TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_commits_session_id ON commits(session_id);
CREATE INDEX IF NOT EXISTS idx_commits_parent     ON commits(parent);
CREATE INDEX IF NOT EXISTS idx_commits_timestamp  ON commits(timestamp);

CREATE TABLE IF NOT EXISTS blobs (
    hash        TEXT    NOT NULL PRIMARY KEY,
    size        INTEGER NOT NULL,
    mime_type   TEXT,
    encoding    TEXT    NOT NULL DEFAULT 'base64'
                        CHECK (encoding IN ('base64', 'utf-8'))
);

CREATE TABLE IF NOT EXISTS refs (
    name        TEXT    NOT NULL PRIMARY KEY,
    target      TEXT    NOT NULL REFERENCES commits(hash) ON DELETE RESTRICT,
    type        TEXT    NOT NULL DEFAULT 'branch'
                        CHECK (type IN ('branch', 'tag', 'session-head')),
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target);
CREATE INDEX IF NOT EXISTS idx_refs_type   ON refs(type);

CREATE TABLE IF NOT EXISTS tree_entries (
    tree_hash   TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    blob_hash   TEXT    NOT NULL REFERENCES blobs(hash) ON DELETE RESTRICT,
    size        INTEGER NOT NULL,
    PRIMARY KEY (tree_hash, path)
);

CREATE INDEX IF NOT EXISTS idx_tree_entries_blob_hash ON tree_entries(blob_hash);
"""

# Migration 002 mirrors packages/core/src/migrations/002_author_signature.ts.
MIGRATION_002_SQL = """
ALTER TABLE commits ADD COLUMN author_name  TEXT;
ALTER TABLE commits ADD COLUMN author_email TEXT;
ALTER TABLE commits ADD COLUMN signature    TEXT;
ALTER TABLE commits ADD COLUMN public_key   TEXT;
"""

# Migration 003 mirrors packages/core/src/migrations/003_llm_call.ts.
MIGRATION_003_SQL = """
ALTER TABLE commits ADD COLUMN llm_call TEXT;
"""


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    up: str


MIGRATIONS: List[Migration] = [
    Migration(1, "initial", MIGRATION_001_SQL),
    Migration(2, "author_signature", MIGRATION_002_SQL),
    Migration(3, "llm_call", MIGRATION_003_SQL),
]

TARGET_VERSION = MIGRATIONS[-1].version

# v1 tables in reverse FK dependency order (safe to DROP without FK violations).
_V1_TABLES = ["tree_entries", "refs", "blobs", "commits", "sessions"]

_SCHEMA_VERSION_DDL = """
CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER NOT NULL PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
);
"""


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def get_current_version(conn: sqlite3.Connection) -> int:
    """Detect the DB's current schema version.

    - schema_version present with rows → MAX(version).
    - schema_version absent but ``commits`` exists → 1 (legacy v0.1).
    - otherwise → 0 (fresh DB).
    """
    if _table_exists(conn, "schema_version"):
        row = conn.execute(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version"
        ).fetchone()
        if row and row[0] and row[0] > 0:
            return int(row[0])
        if _table_exists(conn, "commits"):
            return 1
        return 0
    if _table_exists(conn, "commits"):
        return 1
    return 0


def pending_migrations(conn: sqlite3.Connection) -> List[Migration]:
    current = get_current_version(conn)
    return [m for m in MIGRATIONS if m.version > current]


def migration_status(conn: sqlite3.Connection) -> dict:
    return {
        "current": get_current_version(conn),
        "target": TARGET_VERSION,
        "pending": [m.version for m in pending_migrations(conn)],
    }


def _normalize_legacy_v01_schema(conn: sqlite3.Connection) -> None:
    """Rebuild v0.1 tables to match the canonical v1 DDL.

    A real v0.1 database may have been created with a different CREATE TABLE
    statement (e.g., missing FK constraints, missing NOT NULL, missing CHECK).
    SQLite does not support ALTER TABLE to add constraints, so the only way to
    produce a schema-identical DB is to snapshot the data, DROP the tables, and
    re-run MIGRATION_001_SQL from scratch.

    PRAGMA foreign_keys must be OFF during the DROP; this function handles that
    toggle itself and must be called outside any active transaction.
    """
    # Snapshot all existing v1 table data before touching anything.
    snapshots: Dict[str, dict] = {}
    for table in reversed(_V1_TABLES):
        if not _table_exists(conn, table):
            continue
        cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')] # type: ignore[misc]
        rows = conn.execute(f'SELECT * FROM "{table}"').fetchall()
        snapshots[table] = {"cols": cols, "rows": [list(r) for r in rows]}

    # Commit any pending work before toggling PRAGMA foreign_keys.
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.commit()

    try:
        # Drop tables in reverse FK order so no RESTRICT constraint fires.
        for table in _V1_TABLES:
            if _table_exists(conn, table):
                conn.execute(f'DROP TABLE "{table}"')
        conn.commit()

        # Recreate using the canonical v1 DDL (with all FK/CHECK/NOT NULL).
        # executescript always commits first (fine here) then runs in autocommit.
        conn.executescript(MIGRATIONS[0].up)

        # Re-insert snapshotted data, mapping old columns to canonical columns.
        for table in reversed(_V1_TABLES):
            snap = snapshots.get(table)
            if not snap or not snap["rows"]:
                continue
            canon_cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')] # type: ignore[misc]
            insert_cols = [c for c in snap["cols"] if c in canon_cols]
            if not insert_cols:
                continue
            placeholders = ",".join(["?"] * len(insert_cols))
            col_indices = [snap["cols"].index(c) for c in insert_cols]
            for row in snap["rows"]:
                values = [row[i] for i in col_indices]
                conn.execute(
                    f'INSERT INTO "{table}" ({",".join(insert_cols)}) VALUES ({placeholders})',
                    values,
                )
        conn.commit()
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.commit()


def run_migrations(conn: sqlite3.Connection) -> dict:
    """Apply pending migrations and return the post-migration status.

    Legacy v0.1 fixtures are *normalized* before being marked v1: the runner
    snapshots data, drops the old tables (with FK enforcement off), and
    re-creates them from the canonical MIGRATION_001_SQL. This guarantees that
    the resulting sqlite_master DDL is byte-identical to a fresh v2 install,
    regardless of which v0.1 build originally created the database.

    Raises ``RuntimeError`` if the DB version is newer than ``TARGET_VERSION``.
    """
    conn.executescript(_SCHEMA_VERSION_DDL)
    current = get_current_version(conn)
    if current > TARGET_VERSION:
        raise RuntimeError(
            f"agentgit: database schema version {current} is newer than the "
            f"maximum version this build supports ({TARGET_VERSION}). Upgrade agentgit."
        )

    v1_recorded = (
        conn.execute(
            "SELECT COUNT(*) FROM schema_version WHERE version=1"
        ).fetchone()[0]
        > 0
    )

    # Normalize legacy v0.1 fixtures BEFORE the main writes because
    # PRAGMA foreign_keys cannot be reliably changed inside a transaction.
    if current >= 1 and not v1_recorded:
        _normalize_legacy_v01_schema(conn)
        conn.execute(
            "INSERT INTO schema_version (version, name, applied_at) VALUES (?,?,?)",
            (MIGRATIONS[0].version, MIGRATIONS[0].name, _now_ms()),
        )

    for m in MIGRATIONS:
        if m.version <= current:
            continue
        conn.executescript(m.up)
        conn.execute(
            "INSERT INTO schema_version (version, name, applied_at) VALUES (?,?,?)",
            (m.version, m.name, _now_ms()),
        )
    conn.commit()
    return migration_status(conn)
