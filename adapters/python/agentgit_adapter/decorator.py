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


# ---------------------------------------------------------------------------
# @agentgit_record_llm — decorator for LLM-calling functions
# ---------------------------------------------------------------------------


from typing import Any as _Any, Callable as _Callable, Dict as _Dict, Optional as _Optional, Union as _Union  # local aliases


def openai_chat_extractor(
    args: tuple[_Any, ...], kwargs: _Dict[str, _Any], result: _Any
) -> _Dict[str, _Any]:
    """Built-in extractor for the common ``openai>=1.0`` chat completion shape.

    Works when the decorated function either:
      * forwards ``model`` / ``messages`` through ``kwargs`` to ``client.chat.completions.create``, or
      * receives a plain ``prompt`` and internally constructs the call.

    Pulls ``model``, ``messages``, response text and token usage from the
    returned ``ChatCompletion`` (or equivalent dict).
    """
    model = kwargs.get("model") or getattr(result, "model", "unknown-model")
    messages: list[_Dict[str, str]] = kwargs.get("messages") or []
    if not messages and args:
        # support def ask(prompt: str) style
        first = args[0] if args else None
        if isinstance(first, str):
            messages = [{"role": "user", "content": first}]
        elif isinstance(first, (list, tuple)) and first and isinstance(first[0], dict):
            messages = list(first)

    response = ""
    if result is not None:
        try:
            if hasattr(result, "choices") and result.choices:
                msg = result.choices[0].message
                response = getattr(msg, "content", "") or ""
            elif isinstance(result, dict):
                ch = result.get("choices") or []
                if ch:
                    response = (ch[0].get("message") or {}).get("content", "") or ""
                else:
                    response = result.get("content", "") or str(result)
        except Exception:
            response = str(result)[:500]

    usage: _Optional[_Dict[str, int]] = None
    u = getattr(result, "usage", None)
    if u is None and isinstance(result, dict):
        u = result.get("usage")
    if u:
        pt = getattr(u, "prompt_tokens", None) or (u.get("prompt_tokens") if isinstance(u, dict) else None) or 0
        ct = getattr(u, "completion_tokens", None) or (u.get("completion_tokens") if isinstance(u, dict) else None) or 0
        tt = getattr(u, "total_tokens", None) or (u.get("total_tokens") if isinstance(u, dict) else None) or (pt + ct)
        usage = {"promptTokens": int(pt), "completionTokens": int(ct), "totalTokens": int(tt)}

    return {
        "model": str(model),
        "messages": messages,
        "response": response,
        "usage": usage,
    }


def agentgit_record_llm(
    _func: _Optional[_Callable[..., _Any]] = None,
    *,
    repo_path: str = ".agentgit-repo",
    provider: str = "openai",
    extract: _Callable[[tuple, _Dict, _Any], _Dict] = openai_chat_extractor,
    session_name: _Optional[str] = None,
    guards: _Union[Sequence, bool, None] = None,
) -> _Callable[..., _Any]:
    """Decorator that records the LLM call performed inside ``func`` as an LlmCall commit.

    Usage::

        from agentgit_adapter import agentgit_record_llm, openai_chat_extractor

        @agentgit_record_llm(repo_path=".", provider="openai", extract=openai_chat_extractor)
        def ask(prompt: str) -> str:
            resp = client.chat.completions.create(model="gpt-4o", messages=[{"role":"user","content":prompt}])
            return resp.choices[0].message.content

    The ``extract(args, kwargs, result)`` hook projects the provider-specific
    shapes onto the canonical LlmCall fields. ``openai_chat_extractor`` is
    supplied out of the box.
    """

    def _decorate(func: _Callable[..., _Any]) -> _Callable[..., _Any]:
        state: dict = {"wrapper": None}

        class _CallableWrap:
            name = session_name or func.__name__

            def __call__(self, *args: _Any, **kwargs: _Any) -> _Any:
                return func(*args, **kwargs)

        @functools.wraps(func)
        def wrapper(*args: _Any, **kwargs: _Any) -> _Any:
            if state["wrapper"] is None:
                state["wrapper"] = AgentWrapper(
                    _CallableWrap(), repo_path, guards=guards
                )
            result = func(*args, **kwargs)
            try:
                info = extract(args, kwargs, result) or {}
                state["wrapper"].record_llm_call(
                    provider=provider,
                    model=info.get("model", "unknown"),
                    messages=info.get("messages", []),
                    response=info.get("response", ""),
                    usage=info.get("usage"),
                    # started/completed left to auto-stamp
                )
            except Exception:
                # Never let recording failure break the user call
                pass
            return result

        def finish(status: str = "completed") -> None:
            if state["wrapper"] is not None:
                state["wrapper"].finish(status)
                state["wrapper"] = None

        wrapper.finish = finish  # type: ignore[attr-defined]
        wrapper._agentgit_state = state  # type: ignore[attr-defined]
        return wrapper

    if _func is not None and callable(_func):
        return _decorate(_func)
    return _decorate
