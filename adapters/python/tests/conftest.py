import os
import sqlite3
import sys
from pathlib import Path

import pytest

ADAPTER_ROOT = Path(__file__).resolve().parents[1]
if str(ADAPTER_ROOT) not in sys.path:
    sys.path.insert(0, str(ADAPTER_ROOT))

# Register the pytest plugin module by path so the `agentgit_session` fixture
# is available without requiring `pip install agentgit-adapter` first.
pytest_plugins = ["agentgit_adapter.pytest_plugin"]

SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT    NOT NULL PRIMARY KEY,
    name        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'completed', 'failed', 'abandoned')),
    head        TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    metadata    TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS commits (
    hash        TEXT    NOT NULL PRIMARY KEY,
    tree        TEXT    NOT NULL,
    parent      TEXT,
    session_id  TEXT    NOT NULL,
    timestamp   INTEGER NOT NULL,
    message     TEXT    NOT NULL,
    tool_call   TEXT,
    metadata    TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS blobs (
    hash        TEXT    NOT NULL PRIMARY KEY,
    size        INTEGER NOT NULL,
    mime_type   TEXT,
    encoding    TEXT    NOT NULL DEFAULT 'utf-8'
);

CREATE TABLE IF NOT EXISTS refs (
    name        TEXT    NOT NULL PRIMARY KEY,
    target      TEXT    NOT NULL,
    type        TEXT    NOT NULL DEFAULT 'branch',
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tree_entries (
    tree_hash   TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    blob_hash   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    PRIMARY KEY (tree_hash, path)
);
"""


class MockAgent:
    name = "mock_tool"

    def __call__(self, query: str = "", **kwargs) -> str:
        return f"result for: {query}"


class ErrorAgent:
    name = "error_tool"

    def __call__(self, *args, **kwargs):
        raise ValueError("agent error")


@pytest.fixture
def tmp_repo(tmp_path):
    agentgit_dir = tmp_path / ".agentgit"
    agentgit_dir.mkdir()
    (agentgit_dir / "objects").mkdir()
    (agentgit_dir / "refs").mkdir()
    (agentgit_dir / "HEAD").write_text("ref: refs/sessions/main")

    conn = sqlite3.connect(str(agentgit_dir / "index.db"))
    conn.executescript(SCHEMA_DDL)
    conn.close()

    return str(tmp_path)


@pytest.fixture
def mock_agent():
    return MockAgent()


@pytest.fixture
def error_agent():
    return ErrorAgent()


@pytest.fixture
def wrapped(tmp_repo, mock_agent):
    from agentgit_adapter import wrap_agent

    return wrap_agent(mock_agent, tmp_repo)


def db_rows(tmp_repo: str, query: str, params=()):
    db_path = os.path.join(tmp_repo, ".agentgit", "index.db")
    conn = sqlite3.connect(db_path)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return rows
