"""Test that AgentGitCallbackHandler.on_llm_end writes a structured LlmCall commit."""
from __future__ import annotations

import json
import os
import sqlite3
from typing import Any, Dict, List

import pytest
from langchain_core.outputs import Generation, LLMResult

from agentgit_langchain import AgentGitCallbackHandler


class _FakeLLM:
    """Minimal stand-in for a LangChain LLM that the handler can be attached to."""

    def __init__(self) -> None:
        self.name = "chat-openai"

    def invoke(self, prompt: str) -> str:
        return "fake response"


def _commit_with_llm_call(repo: str) -> Dict[str, Any] | None:
    conn = sqlite3.connect(f"{repo}/.agentgit/index.db")
    try:
        row = conn.execute(
            "SELECT hash, llm_call, message FROM commits WHERE llm_call IS NOT NULL ORDER BY timestamp DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        return {
            "hash": row[0],
            "llm_call": json.loads(row[1]) if row[1] else None,
            "message": row[2],
        }
    finally:
        conn.close()


def test_on_llm_end_writes_structured_llm_call(tmp_path):
    repo = str(tmp_path)
    handler = AgentGitCallbackHandler(repo_path=repo, guards=False)

    # Simulate LangChain callback sequence
    handler.on_llm_start(
        {"name": "ChatOpenAI"},
        ["What is the capital of France?"],
        invocation_params={"model_name": "gpt-4o"},
    )

    result = LLMResult(
        generations=[[Generation(text="Paris is the capital of France.")]],
        llm_output={"token_usage": {"prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19}},
    )
    handler.on_llm_end(result)

    commit = _commit_with_llm_call(repo)
    assert commit is not None
    llm = commit["llm_call"]
    assert llm is not None
    assert llm["provider"] == "langchain"
    assert llm["model"] == "gpt-4o"
    assert "Paris" in llm["response"]
    assert llm["usage"] == {"promptTokens": 12, "completionTokens": 7, "totalTokens": 19}
    assert llm["status"] == "success"
    assert commit["message"].startswith("LLM: gpt-4o")


def test_on_llm_end_without_start_is_noop(tmp_path):
    repo = str(tmp_path)
    handler = AgentGitCallbackHandler(repo_path=repo, guards=False)
    result = LLMResult(generations=[[Generation(text="orphan")]])
    handler.on_llm_end(result)  # should not raise and not write
    db_path = f"{repo}/.agentgit/index.db"
    if not os.path.exists(db_path):
        # noop did not initialise the repo — acceptable
        return
    conn = sqlite3.connect(db_path)
    try:
        count = conn.execute("SELECT COUNT(*) FROM commits").fetchone()[0]
        assert count == 0
    finally:
        conn.close()
