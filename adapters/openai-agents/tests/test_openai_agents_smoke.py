"""Smoke test for the OpenAI Agents SDK adapter.

A minimal stub of the SDK's `Agent` class — just `name` + `run_step` — is
enough to verify the wrapping path: each `run_step` call should produce one
commit in the configured AgentGit repo.
"""

from __future__ import annotations

import sqlite3

from agentgit_openai_agents import wrap_agent


class FakeOpenAIAgent:
    name = "search-agent"

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def run_step(self, payload: dict) -> dict:
        self.calls.append(payload)
        return {"role": "assistant", "content": f"answered:{payload.get('q')}"}


def _commit_count(repo: str) -> int:
    conn = sqlite3.connect(f"{repo}/.agentgit/index.db")
    try:
        return conn.execute("SELECT COUNT(*) FROM commits").fetchone()[0]
    finally:
        conn.close()


def test_wrap_agent_records_commit_per_run_step(tmp_path):
    agent = FakeOpenAIAgent()
    wrapped = wrap_agent(agent, str(tmp_path), guards=False)

    out = agent.run_step({"q": "hello"})
    assert out == {"role": "assistant", "content": "answered:hello"}

    agent.run_step({"q": "world"})
    wrapped.finish()

    assert _commit_count(str(tmp_path)) == 2
    assert wrapped.session_id is None  # finish() resets the active session
