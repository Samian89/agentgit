"""Test for migration 003 (llm_call column) in the Python adapter.

Mirrors the expectation that run_migrations on a v2-shaped fixture advances
to v3 and adds the llm_call TEXT column to commits.
"""
from __future__ import annotations

import sqlite3

import pytest

from agentgit_adapter.migrations import (
    MIGRATION_001_SQL,
    MIGRATION_002_SQL,
    TARGET_VERSION,
    get_current_version,
    migration_status,
    run_migrations,
)


@pytest.fixture
def v2_db(tmp_path):
    """A fresh DB at exactly version 2 (no llm_call column yet)."""
    conn = sqlite3.connect(str(tmp_path / "index.db"))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(MIGRATION_001_SQL)
    conn.executescript(MIGRATION_002_SQL)
    # schema_version table + v1/v2 rows to simulate a v2-migrated DB (run_migrations creates the table)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS schema_version (
            version    INTEGER NOT NULL PRIMARY KEY,
            name       TEXT    NOT NULL,
            applied_at INTEGER NOT NULL
        );
        """
    )
    now = 1_700_000_000_000
    conn.execute(
        "INSERT OR IGNORE INTO schema_version (version, name, applied_at) VALUES (?,?,?)",
        (1, "initial", now),
    )
    conn.execute(
        "INSERT OR IGNORE INTO schema_version (version, name, applied_at) VALUES (?,?,?)",
        (2, "author_signature", now),
    )
    conn.commit()
    yield conn
    conn.close()


def test_target_version_is_3():
    assert TARGET_VERSION == 3


def test_run_migrations_on_v2_fixture_advances_to_v3(v2_db):
    conn = v2_db
    assert get_current_version(conn) == 2
    status = run_migrations(conn)
    assert status["current"] == 3
    assert status["target"] == TARGET_VERSION
    assert status["pending"] == []

    # llm_call column must now exist
    cols = {r[1] for r in conn.execute("PRAGMA table_info(commits)").fetchall()}
    assert "llm_call" in cols

    # schema_version records the v3 migration
    rows = conn.execute(
        "SELECT version, name FROM schema_version ORDER BY version"
    ).fetchall()
    assert (3, "llm_call") in rows


def test_migration_status_reports_v3_after_upgrade(v2_db):
    run_migrations(v2_db)
    st = migration_status(v2_db)
    assert st["current"] == 3
    assert st["target"] == 3
