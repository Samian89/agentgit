"""Smoke test for the CrewAI adapter."""

from __future__ import annotations

import sqlite3


class FakeTask:
    def __init__(self, description: str) -> None:
        self.description = description
        self.executed = False

    def execute(self, *_args, **_kwargs):
        self.executed = True
        return f"done:{self.description}"


class FakeCrew:
    name = "research-crew"

    def __init__(self) -> None:
        self.tasks = [FakeTask("research"), FakeTask("write")]

    def kickoff(self, *_args, **_kwargs):
        results = []
        for task in self.tasks:
            results.append(task.execute())
        return {"results": results}


def _commit_count(repo: str) -> int:
    conn = sqlite3.connect(f"{repo}/.agentgit/index.db")
    try:
        return conn.execute("SELECT COUNT(*) FROM commits").fetchone()[0]
    finally:
        conn.close()


def test_wrap_crew_records_commit_per_kickoff_and_task(tmp_path):
    from agentgit_crewai import wrap_crew

    crew = FakeCrew()
    wrapped = wrap_crew(crew, str(tmp_path), guards=False)

    out = crew.kickoff(inputs={"topic": "agentgit"})
    assert len(out["results"]) == 2
    wrapped.finish()

    # 1 commit for kickoff + 1 per task
    assert _commit_count(str(tmp_path)) == 1 + len(crew.tasks)
