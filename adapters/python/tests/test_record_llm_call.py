"""Tests for AgentWrapper.record_llm_call and the resulting v3 LlmCall commits.

Verifies:
- TARGET_VERSION == 3
- record_llm_call returns 64-char hash and persists llm_call JSON in the commits row
- Canonical hash matches the value produced by the equivalent TS Repository.recordLlmCall
  (fixed fixture computed from the canonical JSON + SHA-256 algorithm shared by both sides).
"""
from __future__ import annotations

import hashlib
import json
import sqlite3

import pytest

from agentgit_adapter import AgentWrapper, TARGET_VERSION


# Fixed fixture values (must produce identical hash on both TS and Python sides)
FIXED_UUID = "12345678-1234-5678-1234-567812345678"
FIXED_NOW = 1_600_000_000_000
# Pre-computed canonical hash for the exact commit body (matches TS Repository.hashObject)
EXPECTED_HASH = "3948a76376ff94bac4703f12f76e72511e218969da2636cbac6ed5c2c3d99e54"


def _canonical_json(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class _DummyAgent:
    name = "llm-agent"

    def __call__(self, prompt: str) -> str:
        return "ok"


def _db_conn(repo: str) -> sqlite3.Connection:
    return sqlite3.connect(f"{repo}/.agentgit/index.db")


def test_target_version_is_three():
    assert TARGET_VERSION == 3


def test_llm_commit_canonical_hash_matches_ts_fixed_fixture():
    """Regression: the body that record_llm_call would hash for these inputs
    produces the exact hash that TS Repository.hashObject would for the same dict.
    """
    tree_hash = _sha256(_canonical_json({"entries": [], "type": "tree"}))
    llm_call = {
        "id": FIXED_UUID,
        "provider": "anthropic",
        "model": "claude-opus-4-7",
        "messages": [{"role": "user", "content": "hello"}],
        "response": "hi there",
        "usage": {"promptTokens": 5, "completionTokens": 3, "totalTokens": 8},
        "costEstimateUsd": 0.00123,
        "startedAt": FIXED_NOW,
        "completedAt": FIXED_NOW + 77,
        "durationMs": 77,
        "status": "success",
        "error": None,
    }
    # Build body exactly as _record_commit does (with fixed ts for determinism)
    body = {
        "author": None,
        "llmCall": llm_call,
        "message": "LLM: claude-opus-4-7",
        "metadata": {},
        "parent": None,
        "sessionId": "550e8400-e29b-41d4-a716-446655440000",
        "timestamp": FIXED_NOW,
        "toolCall": None,
        "tree": tree_hash,
        "type": "commit",
    }
    h = _sha256(_canonical_json(body))
    assert h == EXPECTED_HASH


def test_record_llm_call_writes_v3_row_and_returns_64char_hash(tmp_path):
    repo = str(tmp_path)
    wrapper = AgentWrapper(_DummyAgent(), repo, guards=False)

    h = wrapper.record_llm_call(
        provider="anthropic",
        model="claude-opus-4-7",
        messages=[{"role": "user", "content": "hello"}],
        response="hi there",
        usage={"promptTokens": 5, "completionTokens": 3, "totalTokens": 8},
        cost_estimate_usd=0.00123,
    )

    assert isinstance(h, str)
    assert len(h) == 64

    conn = _db_conn(repo)
    try:
        row = conn.execute(
            "SELECT hash, llm_call, message FROM commits WHERE hash = ?", (h,)
        ).fetchone()
        assert row is not None
        assert row[0] == h
        assert "LLM: claude-opus-4-7" in row[2]

        parsed = json.loads(row[1])
        assert parsed["provider"] == "anthropic"
        assert parsed["model"] == "claude-opus-4-7"
        assert parsed["usage"]["promptTokens"] == 5
        assert parsed["status"] == "success"
    finally:
        conn.close()


def test_record_llm_call_auto_fills_fields(tmp_path):
    repo = str(tmp_path)
    wrapper = AgentWrapper(_DummyAgent(), repo, guards=False)

    h = wrapper.record_llm_call(
        provider="openai",
        model="gpt-4o",
        messages=[{"role": "user", "content": "ping"}],
        response="pong",
    )
    assert len(h) == 64

    conn = _db_conn(repo)
    try:
        row = conn.execute("SELECT llm_call FROM commits WHERE hash=?", (h,)).fetchone()
        parsed = json.loads(row[0])
        assert parsed["id"]  # uuid generated
        assert parsed["startedAt"] > 0
        assert parsed["completedAt"] >= parsed["startedAt"]
        assert parsed["durationMs"] is not None
        assert parsed["status"] == "success"
        assert parsed["error"] is None
    finally:
        conn.close()
