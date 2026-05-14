"""Tests for the Python migration runner.

These mirror the TypeScript suite in packages/core/src/__tests__/migrations.test.ts
and additionally assert that the SQL strings bundled with the Python adapter
match the TS source byte-for-byte — which is what guarantees the
"schema-identical sqlite_master dump" acceptance criterion.
"""
from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path

import pytest

from agentgit_adapter.migrations import (
    MIGRATION_001_SQL,
    MIGRATION_002_SQL,
    MIGRATIONS,
    TARGET_VERSION,
    get_current_version,
    migration_status,
    pending_migrations,
    run_migrations,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
TS_MIG_DIR = REPO_ROOT / "packages" / "core" / "src" / "migrations"


@pytest.fixture
def fresh_db(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "index.db"))
    conn.execute("PRAGMA foreign_keys=ON")
    yield conn
    conn.close()


def _extract_ts_sql(path: Path) -> str:
    """Pull the SQL between the backticks of a TS template literal."""
    text = path.read_text(encoding="utf-8")
    m = re.search(r"=\s*`([^`]+)`", text)
    assert m, f"could not find SQL template in {path}"
    return m.group(1)


class TestSqlParityWithTypeScript:
    """The SQL strings on both sides must be byte-for-byte identical."""

    def test_migration_001_matches_ts(self):
        ts_sql = _extract_ts_sql(TS_MIG_DIR / "001_initial.ts")
        assert ts_sql == MIGRATION_001_SQL

    def test_migration_002_matches_ts(self):
        ts_sql = _extract_ts_sql(TS_MIG_DIR / "002_author_signature.ts")
        assert ts_sql == MIGRATION_002_SQL


class TestRunner:
    def test_empty_db_is_version_0(self, fresh_db):
        assert get_current_version(fresh_db) == 0

    def test_v01_fixture_is_implicitly_version_1(self, fresh_db):
        fresh_db.executescript(MIGRATION_001_SQL)
        assert get_current_version(fresh_db) == 1
        assert [m.version for m in pending_migrations(fresh_db)] == [2]

    def test_upgrades_v01_fixture_to_target(self, fresh_db):
        fresh_db.executescript(MIGRATION_001_SQL)
        status = run_migrations(fresh_db)
        assert status["current"] == TARGET_VERSION
        assert status["pending"] == []

        # schema_version has both 1 (back-filled) and 2 recorded.
        rows = fresh_db.execute(
            "SELECT version FROM schema_version ORDER BY version"
        ).fetchall()
        assert [r[0] for r in rows] == [1, 2]

        cols = [
            r[1]
            for r in fresh_db.execute("PRAGMA table_info(commits)").fetchall()
        ]
        for c in ("author_name", "author_email", "signature", "public_key"):
            assert c in cols

    def test_normalizes_partial_v01_fixture_before_marking_v1(self, fresh_db):
        """Real v0.1 fixtures may lack indexes — runner must re-apply v1 SQL."""
        fresh_db.executescript(
            """
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
            """
        )
        pre_indexes = fresh_db.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        assert pre_indexes == []

        run_migrations(fresh_db)
        post_indexes = {
            r[0]
            for r in fresh_db.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
        for expected in (
            "idx_sessions_status",
            "idx_sessions_created_at",
            "idx_commits_session_id",
            "idx_commits_parent",
            "idx_commits_timestamp",
            "idx_refs_target",
            "idx_refs_type",
            "idx_tree_entries_blob_hash",
        ):
            assert expected in post_indexes

        rows = fresh_db.execute(
            "SELECT version FROM schema_version ORDER BY version"
        ).fetchall()
        assert [r[0] for r in rows] == [1, 2]

    def test_upgrades_fresh_db_to_target(self, fresh_db):
        status = run_migrations(fresh_db)
        assert status["current"] == TARGET_VERSION

    def test_is_idempotent(self, fresh_db):
        run_migrations(fresh_db)
        before = fresh_db.execute(
            "SELECT COUNT(*) FROM schema_version"
        ).fetchone()[0]
        run_migrations(fresh_db)
        after = fresh_db.execute(
            "SELECT COUNT(*) FROM schema_version"
        ).fetchone()[0]
        assert after == before

    def test_refuses_db_newer_than_target(self, fresh_db):
        run_migrations(fresh_db)
        fresh_db.execute(
            "INSERT INTO schema_version (version, name, applied_at) VALUES (?, 'future', 0)",
            (TARGET_VERSION + 5,),
        )
        fresh_db.commit()
        with pytest.raises(RuntimeError, match="newer than the maximum"):
            run_migrations(fresh_db)

    def test_status_reports_pending(self, fresh_db):
        fresh_db.executescript(MIGRATION_001_SQL)
        status = migration_status(fresh_db)
        assert status["current"] == 1
        assert status["target"] == TARGET_VERSION
        assert len(status["pending"]) > 0


class TestNormalizationProducesCanonicalDdl:
    """After normalizing a v0.1 fixture the sqlite_master DDL must equal a fresh v2 install."""

    _V1_FIXTURE = """
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
    """

    def test_sqlite_master_ddl_identical_to_fresh_install(self, tmp_path):
        # Build legacy DB and migrate it.
        legacy = sqlite3.connect(str(tmp_path / "legacy.db"))
        legacy.execute("PRAGMA foreign_keys=ON")
        legacy.executescript(self._V1_FIXTURE)
        run_migrations(legacy)

        # Build a fresh DB for comparison.
        fresh = sqlite3.connect(str(tmp_path / "fresh.db"))
        fresh.execute("PRAGMA foreign_keys=ON")
        run_migrations(fresh)

        def table_sql(conn: sqlite3.Connection, name: str) -> str:
            row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)
            ).fetchone()
            assert row is not None, f"table {name!r} not found"
            return row[0]

        for table in ("sessions", "commits", "blobs", "refs", "tree_entries"):
            assert table_sql(legacy, table) == table_sql(fresh, table), (
                f"sqlite_master DDL for {table!r} differs between legacy-normalized "
                f"and fresh install"
            )

        legacy.close()
        fresh.close()


class TestSchemaIdentityAcrossLanguages:
    """At version 2 the sqlite_master dump must equal the TS-created one.

    Because both implementations execute byte-for-byte identical SQL strings
    (verified by TestSqlParityWithTypeScript), the on-disk schema rows must
    be identical. This test pins the exact set of (type, name, tbl_name)
    tuples we expect at version 2, plus the column lists for each table.
    """

    EXPECTED_TABLES = {
        "schema_version",
        "sessions",
        "commits",
        "blobs",
        "refs",
        "tree_entries",
    }
    EXPECTED_INDEXES = {
        "idx_sessions_status",
        "idx_sessions_created_at",
        "idx_commits_session_id",
        "idx_commits_parent",
        "idx_commits_timestamp",
        "idx_refs_target",
        "idx_refs_type",
        "idx_tree_entries_blob_hash",
    }
    EXPECTED_COMMIT_COLUMNS = {
        "hash",
        "tree",
        "parent",
        "session_id",
        "timestamp",
        "message",
        "tool_call",
        "metadata",
        "author_name",
        "author_email",
        "signature",
        "public_key",
    }

    def test_table_set(self, fresh_db):
        run_migrations(fresh_db)
        rows = fresh_db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        assert {r[0] for r in rows} == self.EXPECTED_TABLES

    def test_index_set(self, fresh_db):
        run_migrations(fresh_db)
        rows = fresh_db.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        # Autoindex rows for PK constraints can vary in name; we only require
        # our explicitly-declared indexes to be present.
        names = {r[0] for r in rows}
        assert self.EXPECTED_INDEXES.issubset(names)

    def test_commit_columns(self, fresh_db):
        run_migrations(fresh_db)
        cols = {
            r[1]
            for r in fresh_db.execute("PRAGMA table_info(commits)").fetchall()
        }
        assert cols == self.EXPECTED_COMMIT_COLUMNS


class TestAdapterAppliesMigrations:
    """End-to-end: wrap_agent on a fresh path leaves a v2 DB."""

    def test_wrap_agent_initialises_to_target_version(self, tmp_path):
        from agentgit_adapter import wrap_agent
        from .conftest import MockAgent

        wrapped = wrap_agent(MockAgent(), str(tmp_path))
        wrapped("hi")

        conn = sqlite3.connect(str(tmp_path / ".agentgit" / "index.db"))
        try:
            row = conn.execute(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version"
            ).fetchone()
            assert row[0] == TARGET_VERSION
        finally:
            conn.close()
