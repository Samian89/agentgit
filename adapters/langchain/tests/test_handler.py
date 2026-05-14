import json
import os

import pytest
from langchain_core.agents import AgentAction, AgentFinish
from langchain_core.outputs import Generation, LLMResult

from agentgit_langchain import AgentGitCallbackHandler
from .conftest import db_rows


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------


class TestSessionLifecycle:
    def test_on_agent_action_opens_session(self, handler, tmp_repo):
        handler.on_agent_action(AgentAction(tool="search", tool_input="q", log=""))

        assert handler._session_id is not None
        rows = db_rows(tmp_repo, "SELECT status FROM sessions WHERE id=?", (handler._session_id,))
        assert rows and rows[0][0] == "active"

    def test_on_agent_finish_marks_session_completed(self, handler, tmp_repo):
        handler.on_agent_action(AgentAction(tool="search", tool_input="q", log=""))
        session_id = handler._session_id

        handler.on_agent_finish(AgentFinish(return_values={"output": "done"}, log=""))

        assert handler._session_id is None
        rows = db_rows(tmp_repo, "SELECT status FROM sessions WHERE id=?", (session_id,))
        assert rows[0][0] == "completed"

    def test_repeated_agent_action_reuses_session(self, handler, tmp_repo):
        action = AgentAction(tool="search", tool_input="q", log="")
        handler.on_agent_action(action)
        first_id = handler._session_id
        handler.on_agent_action(action)

        assert handler._session_id == first_id
        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM sessions")[0][0]
        assert count == 1

    def test_agent_finish_without_open_session_is_noop(self, handler, tmp_repo):
        handler.on_agent_finish(AgentFinish(return_values={}, log=""))
        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM sessions")[0][0]
        assert count == 0


# ---------------------------------------------------------------------------
# Tool call recording
# ---------------------------------------------------------------------------


class TestToolCallRecording:
    def _setup(self, handler):
        handler.on_agent_action(AgentAction(tool="search", tool_input="q", log=""))

    def test_tool_start_end_creates_one_commit(self, handler, tmp_repo):
        self._setup(handler)
        handler.on_tool_start({"name": "search"}, "what is AI?")
        handler.on_tool_end("AI is cool")

        commits = db_rows(tmp_repo, "SELECT message, tool_call FROM commits")
        assert len(commits) == 1
        assert "search" in commits[0][0]
        tc = json.loads(commits[0][1])
        assert tc["name"] == "search"
        assert tc["status"] == "success"
        assert tc["output"] == "AI is cool"

    def test_tool_end_updates_session_head(self, handler, tmp_repo):
        self._setup(handler)
        session_id = handler._session_id
        handler.on_tool_start({"name": "search"}, "q")
        handler.on_tool_end("result")

        rows = db_rows(tmp_repo, "SELECT head FROM sessions WHERE id=?", (session_id,))
        assert rows[0][0] == handler._session_head

    def test_sequential_tool_calls_chain_parents(self, handler, tmp_repo):
        self._setup(handler)

        handler.on_tool_start({"name": "search"}, "q1")
        handler.on_tool_end("r1")
        first_hash = handler._session_head

        handler.on_tool_start({"name": "calc"}, "1+1")
        handler.on_tool_end("2")

        commits = db_rows(
            tmp_repo, "SELECT hash, parent FROM commits ORDER BY timestamp"
        )
        assert len(commits) == 2
        assert commits[1][1] == first_hash

    def test_tool_error_records_error_status(self, handler, tmp_repo):
        self._setup(handler)
        handler.on_tool_start({"name": "fetch"}, "http://x")
        handler.on_tool_error(ConnectionError("timeout"))

        commits = db_rows(tmp_repo, "SELECT tool_call FROM commits")
        assert len(commits) == 1
        tc = json.loads(commits[0][0])
        assert tc["status"] == "error"
        assert "timeout" in tc["error"]

    def test_tool_end_without_agent_action_auto_opens_session(self, handler, tmp_repo):
        handler.on_tool_start({"name": "calc"}, "2+2")
        handler.on_tool_end("4")

        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM sessions")[0][0]
        assert count == 1
        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 1

    def test_tool_end_without_prior_tool_start_is_noop(self, handler, tmp_repo):
        self._setup(handler)
        handler.on_tool_end("orphan output")
        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 0

    def test_tool_call_plain_string_input_wrapped(self, handler, tmp_repo):
        self._setup(handler)
        handler.on_tool_start({"name": "search"}, "my query")
        handler.on_tool_end("result")

        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        assert tc["input"]["input"] == "my query"

    def test_tool_call_json_object_input_preserved(self, handler, tmp_repo):
        self._setup(handler)
        handler.on_tool_start({"name": "search"}, '{"query": "AI", "max_results": 5}')
        handler.on_tool_end("results")

        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        assert tc["input"]["query"] == "AI"
        assert tc["input"]["max_results"] == 5

    def test_tool_call_kwargs_inputs_takes_priority(self, handler, tmp_repo):
        self._setup(handler)
        handler.on_tool_start(
            {"name": "search"}, "fallback", inputs={"query": "structured"}
        )
        handler.on_tool_end("result")

        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        assert tc["input"]["query"] == "structured"


# ---------------------------------------------------------------------------
# LLM call recording
# ---------------------------------------------------------------------------


class TestLLMRecording:
    def _setup(self, handler):
        handler.on_agent_action(AgentAction(tool="search", tool_input="q", log=""))

    def _make_llm_result(self, text: str) -> LLMResult:
        return LLMResult(generations=[[Generation(text=text)]])

    def test_llm_start_end_creates_commit(self, handler, tmp_repo):
        self._setup(handler)
        handler.on_llm_start({"name": "ChatOpenAI"}, ["Hello"])
        handler.on_llm_end(self._make_llm_result("Hi there"))

        commits = db_rows(tmp_repo, "SELECT message, metadata FROM commits")
        assert len(commits) == 1
        assert "llm" in commits[0][0]
        meta = json.loads(commits[0][1])
        assert meta["prompts"] == ["Hello"]
        assert "Hi there" in meta["outputs"]

    def test_llm_end_without_start_is_noop(self, handler, tmp_repo):
        self._setup(handler)
        handler.on_llm_end(self._make_llm_result("unexpected"))
        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 0

    def test_llm_multiple_generations_captured(self, handler, tmp_repo):
        self._setup(handler)
        handler.on_llm_start({"name": "model"}, ["p"])
        result = LLMResult(
            generations=[[Generation(text="a"), Generation(text="b")]]
        )
        handler.on_llm_end(result)

        meta = json.loads(db_rows(tmp_repo, "SELECT metadata FROM commits")[0][0])
        assert "a" in meta["outputs"]
        assert "b" in meta["outputs"]


# ---------------------------------------------------------------------------
# Content addressing
# ---------------------------------------------------------------------------


class TestContentAddressing:
    def test_object_files_written_for_commit(self, handler, tmp_repo):
        handler.on_agent_action(AgentAction(tool="t", tool_input="i", log=""))
        handler.on_tool_start({"name": "t"}, "i")
        handler.on_tool_end("o")

        objects_dir = os.path.join(tmp_repo, ".agentgit", "objects")
        files = [
            fname
            for dirpath, _, filenames in os.walk(objects_dir)
            for fname in filenames
        ]
        assert len(files) >= 2  # at least tree + commit

    def test_empty_tree_is_idempotent(self, handler, tmp_repo):
        h1 = handler._empty_tree_hash()
        h2 = handler._empty_tree_hash()
        assert h1 == h2

    def test_commit_hash_is_64_hex_chars(self, handler, tmp_repo):
        handler.on_agent_action(AgentAction(tool="t", tool_input="i", log=""))
        handler.on_tool_start({"name": "t"}, "i")
        handler.on_tool_end("o")

        assert len(handler._session_head) == 64
        assert all(c in "0123456789abcdef" for c in handler._session_head)

    def test_identical_tool_calls_produce_different_commits(self, handler, tmp_repo):
        # Timestamps differ, so hashes should differ
        handler.on_agent_action(AgentAction(tool="t", tool_input="i", log=""))
        handler.on_tool_start({"name": "t"}, "same")
        handler.on_tool_end("same")
        h1 = handler._session_head

        handler.on_tool_start({"name": "t"}, "same")
        handler.on_tool_end("same")
        h2 = handler._session_head

        # Different because timestamps differ (and parent differs)
        assert h1 != h2
