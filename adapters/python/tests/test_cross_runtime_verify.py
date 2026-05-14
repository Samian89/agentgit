"""Cross-runtime verify parity test.

Simulates the TypeScript `Repository.verifyCommit` re-hash path on a
Python-written commit. Specifically:

1. Loads the commit row from SQLite the same way TS's `rowToCommit` does
   (camelCase fields, `author` derived from author_name / author_email).
2. Strips the non-content fields (`hash`, `signature`, `publicKey`) and
   re-hashes via canonical JSON + SHA-256.
3. Asserts the re-hash matches the stored commit hash.

If this test fails, TS `agentgit verify` on the same DB will report
"tampered" for any Python-written commit — the exact bug Review 1
(2026-05-14T19:03:40) flagged.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from typing import Any

import pytest

from agentgit_adapter import wrap_agent
from .conftest import MockAgent


# Fields the TS `sha256` strips before hashing (see packages/core/src/hash.ts).
_NON_CONTENT_FIELDS = {"hash", "signature", "publicKey"}


def _canonical_json(obj: Any) -> str:
    # Must match packages/core/src/hash.ts canonicalJson:
    # JSON.stringify with sorted keys at every level.
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256_stripping_non_content(obj: dict[str, Any]) -> str:
    filtered = {k: v for k, v in obj.items() if k not in _NON_CONTENT_FIELDS}
    return hashlib.sha256(_canonical_json(filtered).encode("utf-8")).hexdigest()


def _row_to_ts_commit(row: sqlite3.Row) -> dict[str, Any]:
    """Mirror of TS rowToCommit() in packages/core/src/sqlite-index.ts."""
    author = (
        {"name": row["author_name"], "email": row["author_email"]}
        if row["author_name"] is not None and row["author_email"] is not None
        else None
    )
    return {
        "hash": row["hash"],
        "type": "commit",
        "tree": row["tree"],
        "parent": row["parent"],
        "sessionId": row["session_id"],
        "timestamp": row["timestamp"],
        "message": row["message"],
        "toolCall": json.loads(row["tool_call"]) if row["tool_call"] else None,
        "metadata": json.loads(row["metadata"]),
        "author": author,
        "signature": row["signature"],
        "publicKey": row["public_key"],
    }


class TestPythonCommitsRoundTripThroughTsVerify:
    def test_unsigned_commit_rehashes_to_stored_hash(self, tmp_path):
        wrapped = wrap_agent(MockAgent(), str(tmp_path))
        wrapped("hello")

        db_path = os.path.join(tmp_path, ".agentgit", "index.db")
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute("SELECT * FROM commits").fetchone()
            assert row is not None
        finally:
            conn.close()

        ts_commit = _row_to_ts_commit(row)
        recomputed = _sha256_stripping_non_content(ts_commit)
        assert recomputed == ts_commit["hash"], (
            "Python-written commit fails the TS verify re-hash check. "
            "The commit body written by adapter.py must match the canonical "
            "shape (including author: null when no author is set)."
        )

    def test_multiple_sequential_commits_all_verify(self, tmp_path):
        wrapped = wrap_agent(MockAgent(), str(tmp_path))
        for i in range(5):
            wrapped(f"call-{i}")

        db_path = os.path.join(tmp_path, ".agentgit", "index.db")
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT * FROM commits ORDER BY timestamp ASC"
            ).fetchall()
        finally:
            conn.close()

        assert len(rows) == 5
        for row in rows:
            ts_commit = _row_to_ts_commit(row)
            assert _sha256_stripping_non_content(ts_commit) == ts_commit["hash"]
