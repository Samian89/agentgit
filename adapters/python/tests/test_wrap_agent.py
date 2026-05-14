import json
import os

import pytest

from agentgit_adapter import AgentWrapper, wrap_agent
from .conftest import ErrorAgent, MockAgent, db_rows


class TestWrapAgent:
    def test_returns_agent_wrapper(self, tmp_repo, mock_agent):
        wrapped = wrap_agent(mock_agent, tmp_repo)
        assert isinstance(wrapped, AgentWrapper)

    def test_call_records_commit(self, wrapped, tmp_repo):
        wrapped("hello")
        commits = db_rows(tmp_repo, "SELECT message, tool_call FROM commits")
        assert len(commits) == 1
        assert "mock_tool" in commits[0][0]

    def test_commit_has_valid_tool_call_schema(self, wrapped, tmp_repo):
        wrapped("test query")
        tc_json = db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0]
        tc = json.loads(tc_json)
        for field in ("id", "name", "input", "output", "startedAt", "completedAt", "status", "error"):
            assert field in tc, f"ToolCall missing field: {field}"

    def test_tool_call_status_is_success(self, wrapped, tmp_repo):
        wrapped("query")
        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        assert tc["status"] == "success"

    def test_tool_call_name_matches_agent(self, wrapped, tmp_repo):
        wrapped("query")
        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        assert tc["name"] == "mock_tool"

    def test_tool_call_input_recorded(self, wrapped, tmp_repo):
        wrapped("my query")
        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        assert "my query" in json.dumps(tc["input"])

    def test_tool_call_output_recorded(self, wrapped, tmp_repo):
        result = wrapped("hello")
        assert result == "result for: hello"
        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        assert "result for: hello" in json.dumps(tc["output"])

    def test_tool_call_timestamps(self, wrapped, tmp_repo):
        wrapped("q")
        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        assert isinstance(tc["startedAt"], int)
        assert isinstance(tc["completedAt"], int)
        assert tc["completedAt"] >= tc["startedAt"]

    def test_tool_call_id_is_uuid(self, wrapped, tmp_repo):
        wrapped("q")
        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        import uuid
        uuid.UUID(tc["id"])  # raises if not valid UUID

    def test_error_records_error_status(self, tmp_repo):
        wrapped = wrap_agent(ErrorAgent(), tmp_repo)
        with pytest.raises(ValueError, match="agent error"):
            wrapped()
        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        assert tc["status"] == "error"
        assert "agent error" in tc["error"]
        assert tc["output"] is None

    def test_error_commit_message_contains_tool_error(self, tmp_repo):
        wrapped = wrap_agent(ErrorAgent(), tmp_repo)
        with pytest.raises(ValueError):
            wrapped()
        msg = db_rows(tmp_repo, "SELECT message FROM commits")[0][0]
        assert "tool error" in msg

    def test_session_created_in_sqlite(self, wrapped, tmp_repo):
        wrapped("q")
        rows = db_rows(tmp_repo, "SELECT status FROM sessions")
        assert len(rows) == 1
        assert rows[0][0] == "active"

    def test_session_name_includes_agent_name(self, wrapped, tmp_repo):
        wrapped("q")
        rows = db_rows(tmp_repo, "SELECT name FROM sessions")
        assert "mock_tool" in rows[0][0]

    def test_sequential_calls_chain_parents(self, wrapped, tmp_repo):
        wrapped("first")
        first_hash = wrapped._session_head
        wrapped("second")
        commits = db_rows(tmp_repo, "SELECT hash, parent FROM commits ORDER BY timestamp")
        assert len(commits) == 2
        assert commits[1][1] == first_hash

    def test_session_head_updated_after_call(self, wrapped, tmp_repo):
        assert wrapped._session_head is None
        wrapped("q")
        assert wrapped._session_head is not None
        rows = db_rows(tmp_repo, "SELECT head FROM sessions WHERE id=?", (wrapped._session_id,))
        assert rows[0][0] == wrapped._session_head

    def test_object_files_written(self, wrapped, tmp_repo):
        wrapped("q")
        objects_dir = os.path.join(tmp_repo, ".agentgit", "objects")
        files = [
            fname
            for dirpath, _, filenames in os.walk(objects_dir)
            for fname in filenames
        ]
        assert len(files) >= 2  # at least tree + commit

    def test_commit_hash_is_64_hex_chars(self, wrapped, tmp_repo):
        wrapped("q")
        assert len(wrapped._session_head) == 64
        assert all(c in "0123456789abcdef" for c in wrapped._session_head)

    def test_finish_marks_session_completed(self, wrapped, tmp_repo):
        wrapped("q")
        session_id = wrapped._session_id
        wrapped.finish()
        rows = db_rows(tmp_repo, "SELECT status FROM sessions WHERE id=?", (session_id,))
        assert rows[0][0] == "completed"
        assert wrapped._session_id is None

    def test_finish_without_open_session_is_noop(self, wrapped, tmp_repo):
        wrapped.finish()  # no session open yet — must not raise

    def test_context_manager_completes_session(self, tmp_repo, mock_agent):
        with wrap_agent(mock_agent, tmp_repo) as agent:
            agent("q")
            session_id = agent._session_id
        rows = db_rows(tmp_repo, "SELECT status FROM sessions WHERE id=?", (session_id,))
        assert rows[0][0] == "completed"

    def test_context_manager_marks_failed_on_exception(self, tmp_repo, mock_agent):
        session_id = None
        with pytest.raises(RuntimeError):
            with wrap_agent(mock_agent, tmp_repo) as agent:
                agent("q")
                session_id = agent._session_id
                raise RuntimeError("boom")
        rows = db_rows(tmp_repo, "SELECT status FROM sessions WHERE id=?", (session_id,))
        assert rows[0][0] == "failed"

    def test_agent_without_name_attr_uses_class_name(self, tmp_repo):
        class AnonymousAgent:
            def __call__(self, x=""):
                return x

        wrapped = wrap_agent(AnonymousAgent(), tmp_repo)
        wrapped("q")
        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        assert tc["name"] == "AnonymousAgent"

    def test_identical_calls_produce_different_commits(self, wrapped, tmp_repo):
        wrapped("same")
        h1 = wrapped._session_head
        wrapped("same")
        h2 = wrapped._session_head
        assert h1 != h2  # timestamps + parent differ

    def test_kwargs_recorded_in_input(self, tmp_repo, mock_agent):
        wrapped = wrap_agent(mock_agent, tmp_repo)
        wrapped(query="hello", extra="world")
        tc = json.loads(db_rows(tmp_repo, "SELECT tool_call FROM commits")[0][0])
        assert tc["input"]["query"] == "hello"
        assert tc["input"]["extra"] == "world"


class TestDirectInit:
    def test_direct_init_when_cli_unavailable(self, tmp_path):
        """AgentWrapper initializes .agentgit/ directly without the CLI."""
        wrapped = wrap_agent(MockAgent(), str(tmp_path))
        wrapped("test")
        agentgit_dir = tmp_path / ".agentgit"
        assert agentgit_dir.is_dir()
        assert (agentgit_dir / "index.db").exists()
        assert (agentgit_dir / "HEAD").exists()
        assert (agentgit_dir / "HEAD").read_text() == "ref: refs/sessions/main"

    def test_direct_init_creates_objects_dir(self, tmp_path):
        wrapped = wrap_agent(MockAgent(), str(tmp_path))
        wrapped("x")
        assert (tmp_path / ".agentgit" / "objects").is_dir()

    def test_existing_repo_not_reinitialised(self, tmp_repo, mock_agent):
        wrapped = wrap_agent(mock_agent, tmp_repo)
        wrapped("first")
        h1 = wrapped._session_head
        # Second wrapper on the same repo must not wipe the DB.
        wrapped2 = wrap_agent(MockAgent(), tmp_repo)
        wrapped2("second")
        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 2


class TestContentAddressing:
    def test_empty_tree_is_idempotent(self, wrapped, tmp_repo):
        h1 = wrapped._empty_tree_hash()
        h2 = wrapped._empty_tree_hash()
        assert h1 == h2

    def test_object_file_sharding(self, wrapped, tmp_repo):
        """Object files are stored under objects/<2-char prefix>/<62-char suffix>."""
        wrapped("q")
        objects_dir = os.path.join(tmp_repo, ".agentgit", "objects")
        for dirpath, dirnames, filenames in os.walk(objects_dir):
            for fname in filenames:
                folder = os.path.basename(dirpath)
                assert len(folder) == 2
                assert len(fname) == 62
