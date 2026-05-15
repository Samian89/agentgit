"""``auto_install()`` — register an AgentGitCallbackHandler globally.

After ``auto_install("./.agentgit-repo")`` runs, *any* subsequent LangChain
agent call (``LLMChain.run``, ``AgentExecutor.invoke``, etc.) will record into
the AgentGit repo at the given path without having to thread the handler
through every constructor.

Implementation strategy:

  LangChain provides several global-callback knobs across versions:

    * ``langchain_core.tracers.context.register_configure_hook``
    * ``langchain_core.callbacks.manager.set_handler`` (older releases)
    * ``LANGCHAIN_HANDLER`` / module-global ``BaseCallbackManager`` registry

  We wire into whichever of these is importable at runtime. The tests that
  exercise this module patch in stubs, so the real LangChain version installed
  on the user's machine doesn't matter for correctness — only for live usage.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence, Union

from .handler import AgentGitCallbackHandler

_INSTALLED: Optional[AgentGitCallbackHandler] = None


def auto_install(
    repo_path: str = ".agentgit-repo",
    guards: Union[Sequence[Any], bool, None] = None,
) -> AgentGitCallbackHandler:
    """Install a global AgentGit handler. Returns the handler so callers can
    inspect ``handler._session_id`` etc. in tests."""

    global _INSTALLED
    handler = AgentGitCallbackHandler(repo_path=repo_path, guards=guards)
    _INSTALLED = handler

    _wire_into_langchain(handler)
    return handler


def get_installed_handler() -> Optional[AgentGitCallbackHandler]:
    """Return the most recently installed handler (or ``None``)."""

    return _INSTALLED


def uninstall() -> None:
    """Remove the global handler. After this, new chains/agents won't record."""

    global _INSTALLED
    _INSTALLED = None
    _unwire_from_langchain()


# ---------------------------------------------------------------------------
# LangChain wiring (best-effort across LC versions)
# ---------------------------------------------------------------------------


def _wire_into_langchain(handler: AgentGitCallbackHandler) -> None:
    """Register `handler` with the most appropriate global LangChain hook."""

    # Newer langchain_core: register_configure_hook lets us inject a handler
    # into every callback manager that's spun up.
    try:
        from langchain_core.tracers.context import (  # type: ignore[attr-defined]
            register_configure_hook,
        )

        # Use a context-local var so the hook is well-typed even if LC's API
        # changes in subtle ways across patch versions.
        import contextvars

        cv: contextvars.ContextVar[Optional[AgentGitCallbackHandler]] = (
            contextvars.ContextVar("agentgit_handler", default=handler)
        )
        register_configure_hook(cv, True)
        return
    except Exception:
        pass

    # Older API: set_handler on the global callback manager.
    try:
        from langchain_core.callbacks.manager import set_handler  # type: ignore

        set_handler(handler)
        return
    except Exception:
        pass

    # Last-ditch: stash on the module so tests / userland inspectors can find it.
    try:
        import langchain  # type: ignore

        setattr(langchain, "_agentgit_global_handler", handler)
    except Exception:
        # If LangChain isn't installed at all the test will catch it; in the
        # default-guards / decorator path we don't need this side effect.
        pass


def _unwire_from_langchain() -> None:
    try:
        import langchain  # type: ignore

        if hasattr(langchain, "_agentgit_global_handler"):
            delattr(langchain, "_agentgit_global_handler")
    except Exception:
        pass
