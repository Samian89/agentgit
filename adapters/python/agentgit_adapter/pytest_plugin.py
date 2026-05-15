"""pytest plugin: ``agentgit_session`` fixture.

Provides a fresh AgentGit repository per test, returning a small handle with:

  * ``path``         — the repo root directory (a tmp path)
  * ``agentgit_dir`` — ``<path>/.agentgit``
  * ``wrap(agent)``  — convenience to wrap any callable with this repo

The fixture is auto-registered through the
``[project.entry-points."pytest11"]`` block in ``pyproject.toml``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Callable, Sequence, Union

import pytest


@dataclass
class AgentGitSession:
    path: str
    agentgit_dir: str

    def wrap(
        self,
        agent: Any,
        guards: Union[Sequence[Any], bool, None] = None,
    ) -> Any:
        from .adapter import wrap_agent

        return wrap_agent(agent, self.path, guards=guards)


@pytest.fixture
def agentgit_session(tmp_path) -> AgentGitSession:
    """Yield an isolated AgentGit repo rooted in tmp_path."""

    repo_path = str(tmp_path)
    agentgit_dir = os.path.join(repo_path, ".agentgit")
    return AgentGitSession(path=repo_path, agentgit_dir=agentgit_dir)
