"""@agentgit_record — function decorator that records each call as a commit.

Usage:

    from agentgit_adapter import agentgit_record

    @agentgit_record(repo_path="./.agentgit-repo", session_name="my-session")
    def lookup(query: str) -> str:
        ...

The first invocation initialises the repo (if needed) and opens a session.
Subsequent calls reuse the same wrapper / session until ``finish()`` is called.
"""

from __future__ import annotations

import functools
from typing import Any, Callable, Optional, Sequence, Union

from .adapter import AgentWrapper


def agentgit_record(
    _func: Optional[Callable[..., Any]] = None,
    *,
    repo_path: str = ".agentgit-repo",
    session_name: Optional[str] = None,
    guards: Union[Sequence[Any], bool, None] = None,
) -> Callable[..., Any]:
    """Decorator that records every call to ``func`` as an AgentGit commit.

    Can be used bare (``@agentgit_record``) for the defaults or with arguments
    (``@agentgit_record(repo_path=..., session_name=...)``).
    """

    def _decorate(func: Callable[..., Any]) -> Callable[..., Any]:
        # Hold one wrapper per decorated function so successive calls land in
        # the same session and chain into a single linear commit history.
        state: dict = {"wrapper": None}

        class _CallableWrap:
            name = session_name or func.__name__

            def __call__(self, *args: Any, **kwargs: Any) -> Any:
                return func(*args, **kwargs)

        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if state["wrapper"] is None:
                state["wrapper"] = AgentWrapper(
                    _CallableWrap(), repo_path, guards=guards
                )
            return state["wrapper"](*args, **kwargs)

        def finish(status: str = "completed") -> None:
            if state["wrapper"] is not None:
                state["wrapper"].finish(status)
                state["wrapper"] = None

        # Expose the underlying wrapper + a finish hook so tests / callers can
        # close the session deterministically.
        wrapper.finish = finish  # type: ignore[attr-defined]
        wrapper._agentgit_state = state  # type: ignore[attr-defined]
        return wrapper

    if _func is not None and callable(_func):
        return _decorate(_func)
    return _decorate
