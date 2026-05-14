# AMC-264f6e13 - Default-safe guards and repository config

## 1. What I built

This cycle addressed the reviewer follow-up and completed the default-guard
path:

- Fixed the combined pytest collection failure by giving adapter test trees a
  distinct package namespace, using package-relative helper imports, and adding
  each adapter root to `sys.path` from its own `conftest.py`.
- Changed the LangChain handler to fail closed when the shared Python guard
  implementation cannot be imported: default guard mode blocks tool calls
  instead of silently falling back to no guards.
- Preserved explicit LangChain opt-out semantics: `guards=False` still runs no
  guards even if the default guard dependency is missing.
- Added LangChain regression tests for missing guard dependencies and opt-out.
- Made the LangChain callback base import tolerant of the local broken
  LangSmith/pydantic environment while still using the real
  `BaseCallbackHandler` when it imports cleanly.
- Kept the default guard implementation in place across SDK, Python adapter,
  and LangChain: `None`/undefined defaults to `ConfirmationGuard` +
  `SnapshotGuard`, `False` disables guards, and explicit arrays are exact
  overrides.
- Fixed bundle unpack validation order so malformed tree objects are rejected
  before reachability checks mask the shape error.

Verification:

```text
pnpm test && pytest adapters/python adapters/langchain

vitest: 24 files passed, 217 tests passed
pytest: 87 passed
```

## 2. Files changed

- `adapters/__init__.py`
- `adapters/langchain/__init__.py`
- `adapters/langchain/agentgit_langchain/handler.py`
- `adapters/langchain/pyproject.toml`
- `adapters/langchain/tests/conftest.py`
- `adapters/langchain/tests/test_handler.py`
- `adapters/langchain/tests/test_langchain_default_guards.py`
- `adapters/python/__init__.py`
- `adapters/python/agentgit_adapter/__init__.py`
- `adapters/python/agentgit_adapter/adapter.py`
- `adapters/python/agentgit_adapter/guards/__init__.py`
- `adapters/python/agentgit_adapter/guards/confirmation_guard.py`
- `adapters/python/agentgit_adapter/guards/loader.py`
- `adapters/python/agentgit_adapter/guards/registry.py`
- `adapters/python/agentgit_adapter/guards/snapshot_guard.py`
- `adapters/python/agentgit_adapter/migrations.py`
- `adapters/python/pyproject.toml`
- `adapters/python/tests/conftest.py`
- `adapters/python/tests/test_cross_runtime_verify.py`
- `adapters/python/tests/test_default_guards.py`
- `adapters/python/tests/test_migrations.py`
- `adapters/python/tests/test_wrap_agent.py`
- `packages/core/src/__tests__/bundle.test.ts`
- `packages/core/src/__tests__/config.test.ts`
- `packages/core/src/__tests__/migrations.test.ts`
- `packages/core/src/__tests__/repository-author-signing.test.ts`
- `packages/core/src/__tests__/signing.test.ts`
- `packages/core/src/__tests__/sqlite-index.test.ts`
- `packages/core/src/bundle/index.ts`
- `packages/core/src/bundle/manifest.ts`
- `packages/core/src/bundle/node-file.ts`
- `packages/core/src/bundle/pack.ts`
- `packages/core/src/bundle/tar.ts`
- `packages/core/src/bundle/unpack.ts`
- `packages/core/src/config.ts`
- `packages/core/src/guards/confirmation-guard.ts`
- `packages/core/src/guards/index.ts`
- `packages/core/src/guards/load-guards.ts`
- `packages/core/src/guards/snapshot-guard.ts`
- `packages/core/src/hash.ts`
- `packages/core/src/index.ts`
- `packages/core/src/migrations/001_initial.ts`
- `packages/core/src/migrations/002_author_signature.ts`
- `packages/core/src/migrations/index.ts`
- `packages/core/src/object-store.ts`
- `packages/core/src/repository.ts`
- `packages/core/src/schema.ts`
- `packages/core/src/signing.ts`
- `packages/core/src/sqlite-index.ts`
- `packages/core/src/types.ts`
- `packages/sdk/src/__tests__/default-guards.test.ts`
- `packages/sdk/src/types.ts`
- `packages/sdk/src/wrap.ts`
- `DONE.md`

## 3. APIs, types, or interfaces other tickets may consume

- `AgentGitCallbackHandler(repo_path, guards=None)` now fails closed if default
  guard dependencies are unavailable.
- `AgentGitCallbackHandler(..., guards=False)` remains the explicit no-guard
  opt-out.
- Explicit LangChain guard arrays continue to run exactly the supplied guards.
