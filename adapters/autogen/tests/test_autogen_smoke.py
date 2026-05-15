"""Smoke test for the AutoGen adapter — uses an in-memory ConversableAgent stub."""

from __future__ import annotations

import sqlite3


class FakeConversableAgent:
    """Minimal stub: name + execute_function + _process_received_message."""

    name = "researcher"

    def __init__(self) -> None:
        self.executed: list = []
        self.received: list = []

    def execute_function(self, func_call, *args, **kwargs):
        self.executed.append(func_call)
        return {"success": True, "func": func_call}

    def _process_received_message(self, message, sender, *_args, **_kwargs):
        self.received.append((message, sender))
        return None


def _commit_count(repo: str) -> int:
    conn = sqlite3.connect(f"{repo}/.agentgit/index.db")
    try:
        return conn.execute("SELECT COUNT(*) FROM commits").fetchone()[0]
    finally:
        conn.close()


def test_wrap_agent_records_commit_per_tool_dispatch(tmp_path):
    from agentgit_autogen import wrap_agent

    agent = FakeConversableAgent()
    wrapped = wrap_agent(agent, str(tmp_path), guards=False)

    out = agent.execute_function({"name": "search", "arguments": {"q": "x"}})
    assert out["success"] is True

    # Inbound message should also produce a commit.
    sender = type("Peer", (), {"name": "user-proxy"})()
    agent._process_received_message({"role": "user", "content": "hello"}, sender)

    wrapped.finish()
    assert _commit_count(str(tmp_path)) == 2
