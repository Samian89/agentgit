"""Tests for ``auto_install()``.

These tests don't depend on a real LangChain agent execution. They verify that
``auto_install`` registers a global handler and that subsequent tool-call
events delivered to that handler land as commits in the configured repo.
"""

from __future__ import annotations

import sqlite3

from langchain_core.agents import AgentAction

from agentgit_langchain import (
    AgentGitCallbackHandler,
    auto_install,
    get_installed_handler,
    uninstall,
)


def _commit_count(repo: str) -> int:
    conn = sqlite3.connect(f"{repo}/.agentgit/index.db")
    try:
        return conn.execute("SELECT COUNT(*) FROM commits").fetchone()[0]
    finally:
        conn.close()


def test_auto_install_returns_handler_and_records_commits(tmp_path):
    repo = str(tmp_path / "repo")
    handler = auto_install(repo_path=repo, guards=False)
    try:
        assert isinstance(handler, AgentGitCallbackHandler)
        assert get_installed_handler() is handler

        handler.on_agent_action(AgentAction(tool="search", tool_input="q", log=""))
        handler.on_tool_start({"name": "search"}, "q")
        handler.on_tool_end("result")

        assert _commit_count(repo) == 1
    finally:
        uninstall()


def test_uninstall_clears_global_handler(tmp_path):
    auto_install(repo_path=str(tmp_path / "repo"), guards=False)
    assert get_installed_handler() is not None
    uninstall()
    assert get_installed_handler() is None
