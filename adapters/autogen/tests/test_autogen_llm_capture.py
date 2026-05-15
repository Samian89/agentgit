"""Smoke test asserting that the autogen adapter records a real LlmCall commit via OAI client hook."""
from __future__ import annotations

import sqlite3
from typing import Any

from agentgit_autogen import wrap_agent


class FakeUsage:
    prompt_tokens = 7
    completion_tokens = 3
    total_tokens = 10


class FakeChatResponse:
    def __init__(self) -> None:
        self.choices = [type("C", (), {"message": type("M", (), {"content": "autogen reply"})()})()]
        self.usage = FakeUsage()


class FakeOAIClient:
    def __init__(self) -> None:
        self.create_calls: list = []

    def create(self, **kwargs: Any) -> FakeChatResponse:
        self.create_calls.append(kwargs)
        return FakeChatResponse()


class FakeConversableAgentForLLM:
    name = "researcher"

    def __init__(self) -> None:
        self.client = FakeOAIClient()
        self.executed: list = []
        self.received: list = []

    def execute_function(self, func_call, *args, **kwargs):
        self.executed.append(func_call)
        return {"success": True}

    def _process_received_message(self, message, sender, *_args, **_kwargs):
        self.received.append((message, sender))
        return None


def _llm_call_count(repo: str) -> int:
    conn = sqlite3.connect(f"{repo}/.agentgit/index.db")
    try:
        return conn.execute("SELECT COUNT(*) FROM commits WHERE llm_call IS NOT NULL").fetchone()[0]
    finally:
        conn.close()


def test_autogen_adapter_records_llm_call_via_client_create(tmp_path):
    agent = FakeConversableAgentForLLM()
    wrapped = wrap_agent(agent, str(tmp_path), guards=False)

    # Trigger the OAI create patch (LLM path)
    agent.client.create(model="gpt-4o", messages=[{"role": "user", "content": "q"}])

    # Also do a tool step so wrapper is exercised
    agent.execute_function({"name": "dummy"})

    wrapped.finish()

    assert _llm_call_count(str(tmp_path)) >= 1
