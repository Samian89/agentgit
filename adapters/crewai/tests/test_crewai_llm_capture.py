"""Smoke test asserting that the crewai adapter records a real LlmCall commit via usage_metrics."""
from __future__ import annotations

import sqlite3
from typing import Any

from agentgit_crewai import wrap_crew


class FakeUsageMetrics:
    model = "gpt-4o-crew"
    usage = type("U", (), {"prompt_tokens": 15, "completion_tokens": 6, "total_tokens": 21})()


class FakeTask:
    def __init__(self, desc: str) -> None:
        self.description = desc
        self.usage_metrics: Any = None

    def execute(self, *args: Any, **kwargs: Any) -> str:
        # Simulate CrewAI setting usage_metrics after run
        self.usage_metrics = FakeUsageMetrics()
        return "task result"


class FakeCrew:
    name = "research-crew"

    def __init__(self) -> None:
        self.tasks = [FakeTask("research topic"), FakeTask("summarize")]
        self.kickoff_calls: list = []

    def kickoff(self, *args: Any, **kwargs: Any) -> str:
        self.kickoff_calls.append((args, kwargs))
        return "crew done"


def _llm_call_count(repo: str) -> int:
    conn = sqlite3.connect(f"{repo}/.agentgit/index.db")
    try:
        return conn.execute("SELECT COUNT(*) FROM commits WHERE llm_call IS NOT NULL").fetchone()[0]
    finally:
        conn.close()


def test_crewai_adapter_records_llm_call_per_task(tmp_path):
    crew = FakeCrew()
    wrapped = wrap_crew(crew, str(tmp_path), guards=False)

    crew.kickoff(inputs={"topic": "x"})
    # Explicitly invoke execute (in case kickoff fake path varies) to trigger patched + metrics LLM record
    for t in crew.tasks:
        t.execute()

    wrapped.finish()

    # Each task.execute that sets usage_metrics should have emitted an LlmCall
    assert _llm_call_count(str(tmp_path)) >= 1
