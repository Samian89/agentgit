"""Smoke test asserting that the openai-agents adapter records a real LlmCall commit."""
from __future__ import annotations

import sqlite3
from typing import Any

from agentgit_openai_agents import wrap_agent


class FakeModelResponse:
    """Stand-in for openai-agents SDK ModelResponse with usage."""

    def __init__(self, model: str, content: str, usage: dict | None = None) -> None:
        self.model = model
        self.output = type("Out", (), {"content": content})()
        self.usage = type("U", (), usage or {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})()


class FakeOpenAIAgentForLLM:
    name = "llm-agent"

    def __init__(self) -> None:
        self.calls: list = []

    def run_step(self, payload: dict) -> Any:
        self.calls.append(payload)
        # Simulate returning a ModelResponse so the LLM hook fires
        return FakeModelResponse("gpt-4o-mini", "hello from model", {"input_tokens": 8, "output_tokens": 4, "total_tokens": 12})


def _llm_call_count(repo: str) -> int:
    conn = sqlite3.connect(f"{repo}/.agentgit/index.db")
    try:
        return conn.execute("SELECT COUNT(*) FROM commits WHERE llm_call IS NOT NULL").fetchone()[0]
    finally:
        conn.close()


def test_openai_agents_adapter_records_llm_call(tmp_path):
    agent = FakeOpenAIAgentForLLM()
    wrapped = wrap_agent(agent, str(tmp_path), guards=False)

    # payload with model triggers the LLM capture path in the patched run_step
    out = agent.run_step({"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]})
    assert "hello from model" in str(out)

    wrapped.finish()

    assert _llm_call_count(str(tmp_path)) >= 1
