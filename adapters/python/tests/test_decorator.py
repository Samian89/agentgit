"""Tests for @agentgit_record and the agentgit_session pytest fixture."""

from __future__ import annotations

import os
import sqlite3
from contextlib import chdir


def _commit_count(repo_path: str) -> int:
    db = sqlite3.connect(f"{repo_path}/.agentgit/index.db")
    try:
        return db.execute("SELECT COUNT(*) FROM commits").fetchone()[0]
    finally:
        db.close()


def test_decorator_records_commit_on_call(tmp_path):
    from agentgit_adapter import agentgit_record

    repo = str(tmp_path / "repo")

    @agentgit_record(repo_path=repo, session_name="lookup", guards=False)
    def lookup(query: str) -> str:
        return f"hit:{query}"

    assert lookup("hello") == "hit:hello"
    assert lookup("world") == "hit:world"
    lookup.finish()

    assert _commit_count(repo) >= 2


def test_decorator_bare_form(tmp_path):
    """Bare @agentgit_record (no parens) uses default repo_path and records commits."""
    from agentgit_adapter import agentgit_record

    repo_root = tmp_path / "proj"
    repo_root.mkdir()
    default_repo_path = repo_root / ".agentgit-repo"  # the value passed to AgentWrapper
    # agentgit_dir will be default_repo_path / ".agentgit"
    expected_db = default_repo_path / ".agentgit" / "index.db"

    with chdir(repo_root):
        @agentgit_record(guards=False)
        def add(a: int, b: int) -> int:
            return a + b

        assert add(2, 3) == 5
        add.finish()

    assert expected_db.exists()
    assert _commit_count(str(default_repo_path)) == 1


def test_agentgit_session_fixture_yields_working_repo(agentgit_session):
    """The pytest fixture should yield a usable repo handle."""

    class Tool:
        name = "echo"

        def __call__(self, msg: str) -> str:
            return msg

    wrapped = agentgit_session.wrap(Tool(), guards=False)
    assert wrapped("hi") == "hi"
    wrapped("there")
    wrapped.finish()

    assert _commit_count(agentgit_session.path) == 2
