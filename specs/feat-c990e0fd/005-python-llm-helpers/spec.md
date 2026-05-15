# Python Adapter LLM Capture Helpers + Migration 003 Mirror

## Goal
Bring the Python adapter family to parity with the TypeScript core's new `LlmCall` first-class commit support. Mirror migration 003 (`ALTER TABLE commits ADD COLUMN llm_call TEXT`) in `agentgit_adapter.migrations`, add a generic `record_llm_call(...)` helper plus an `@agentgit_record_llm` decorator that any Python LLM SDK (OpenAI, Anthropic, Bedrock, …) can call, upgrade `AgentGitCallbackHandler.on_llm_end` to write a typed LlmCall instead of metadata-only commits, and extend the openai-agents / autogen / crewai adapters to capture LLM events emitted by their respective frameworks.

## Context
- `adapters/python/agentgit_adapter/migrations.py` (lines 81–100, 256–263) is the byte-for-byte Python mirror of the TypeScript `MIGRATIONS` registry. Every migration added to `packages/core/src/migrations/index.ts` MUST land here too; the comment block at lines 1–11 documents the invariant and `agentgit migrate --check` enforces it.
- `adapters/python/agentgit_adapter/adapter.py` `_record_commit` (lines 178–238) builds a canonical commit body and inserts a v2-shaped SQL row. The canonical JSON keys are sorted alphabetically (line 14), so adding `"llmCall"` to the body keeps cross-language hash compatibility with the TypeScript core *as long as both sides write `"llmCall": null` when absent*. The SQL row currently lacks an `llm_call` column — migration 003 adds it, and the INSERT statement at lines 209–228 needs to be extended.
- `adapters/langchain/agentgit_langchain/handler.py` `on_llm_end` (lines 511–530) currently writes an LLM event as metadata-only (`{prompts, outputs, llmOutput, startedAt, completedAt}`) without a structured `toolCall`/`llmCall`. The handler should switch to writing a fully-shaped `LlmCall` JSON payload and persist it through the new `llm_call` column. The fallback schema (`_FALLBACK_SCHEMA_SQL`, lines 35–101) used when `agentgit_adapter` is unavailable must also gain the `llm_call` column to stay aligned.
- `adapters/openai-agents/agentgit_openai_agents/adapter.py`, `adapters/autogen/agentgit_autogen/adapter.py`, and `adapters/crewai/agentgit_crewai/adapter.py` all delegate commit writing to the shared `AgentWrapper`. The new helpers in `agentgit_adapter` automatically benefit them — but each framework exposes its own model/usage hooks (OpenAI Agents `ModelResponse`, AutoGen `OAIClient.create` events, CrewAI `usage_metrics`) which this spec wires up so the captured LlmCall has real `usage` and `model` data rather than empty placeholders.
- The CI matrix runs `pytest adapters/python adapters/langchain adapters/openai-agents adapters/autogen adapters/crewai` across Python 3.10/3.11/3.12 (`.github/workflows/ci.yml:82-100`). All new tests must run inside that matrix.
- Spec 001 establishes the canonical `LlmCall` schema on the TS side: `{ id, provider, model, messages, response, usage, costEstimateUsd, startedAt, completedAt, durationMs, status, error }`. The Python implementation MUST use the same JSON field names and order so canonical-JSON hashes match.

## Technical Approach
1. **Migration 003 mirror** in `adapters/python/agentgit_adapter/migrations.py`:
   ```python
   MIGRATION_003_SQL = """
   ALTER TABLE commits ADD COLUMN llm_call TEXT;
   """
   MIGRATIONS.append(Migration(3, "llm_call", MIGRATION_003_SQL))
   ```
   Update `TARGET_VERSION = 3`. The migration runner at `run_migrations` is unchanged because it iterates `MIGRATIONS` declaratively.
2. **Extend `AgentWrapper._record_commit`** (`adapters/python/agentgit_adapter/adapter.py:178-238`):
   - Accept an optional `llm_call: Optional[Dict[str, Any]] = None` parameter.
   - Include `"llmCall": llm_call` in `commit_obj` (alphabetical sort means it falls between `"author"` and `"message"`; verify after writing that the resulting canonical JSON byte-matches the TS commit for an identical input — add a cross-language hash test fixture).
   - Add an `llm_call` column to the INSERT statement.
3. **`record_llm_call`** public helper on `AgentWrapper`:
   ```python
   def record_llm_call(
       self,
       *,
       provider: str,
       model: str,
       messages: List[Dict[str, str]],
       response: str,
       usage: Optional[Dict[str, int]] = None,
       cost_estimate_usd: Optional[float] = None,
       started_at: Optional[int] = None,
       completed_at: Optional[int] = None,
       error: Optional[str] = None,
   ) -> str:
   ```
   Builds the LlmCall dict (auto-fills `id`, timestamps, `durationMs`, `status`), opens/uses the current session, and delegates to `_record_commit`. Returns the new commit hash.
4. **`@agentgit_record_llm` decorator** in `adapters/python/agentgit_adapter/decorator.py`, modeled on the existing `@agentgit_record` (lines 23–68). Usage:
   ```python
   @agentgit_record_llm(repo_path=".agentgit-repo", provider="openai", extract=openai_extractor)
   def ask(prompt: str) -> str: ...
   ```
   `extract(args, kwargs, result) → { model, messages, response, usage }` lets the user tell the helper how to project provider-specific call/return shapes onto the canonical LlmCall fields. Ship at least one ready-made extractor (`openai_chat_extractor`) for the common openai>=1.0 client shape.
5. **LangChain handler upgrade** (`adapters/langchain/agentgit_langchain/handler.py:502-530`):
   - `on_llm_start` captures `serialized`, `prompts`, and `invocation_params` (which carries `model_name` and other params).
   - `on_llm_end` builds an `LlmCall` dict from `response.generations` (joined text), `response.llm_output` (token_usage), and the captured model name. Calls `_record_commit` with `llm_call=...` (no `tool_call`).
   - Extend `_FALLBACK_SCHEMA_SQL` (lines 50–67) so the `commits` table includes `llm_call TEXT` and `schema_version` gets a row for migration 003 (line 248).
6. **Framework adapters** — each of `openai-agents/adapter.py`, `autogen/adapter.py`, `crewai/adapter.py` already imports the shared `AgentWrapper`. Update each to call `wrapper.record_llm_call(...)` at the framework's LLM hook:
   - **OpenAI Agents**: in the `Agent.run_step` patch, when the step's `ModelResponse` is available, extract `output.model`, `usage.input_tokens` / `output.usage.output_tokens`, and the input messages from the step's history.
   - **AutoGen**: hook `OAIClient.create` (or `ConversableAgent._generate_oai_reply_from_client`) to capture the `chat.completions.create` request + response and call `record_llm_call`.
   - **CrewAI**: capture `usage_metrics` aggregated on `Task.execute` and emit one LlmCall per task with model/usage drawn from the CrewAI internals.
7. **Tests**:
   - `adapters/python/tests/test_record_llm_call.py` — direct `record_llm_call` writes a v3 row with the right `llm_call` JSON and the canonical hash matches the TS expected output (use a fixture computed once with the TS implementation and committed as a constant).
   - `adapters/python/tests/test_migration_003.py` — applying `run_migrations` to a v2 fixture DB adds the `llm_call` column.
   - `adapters/langchain/tests/test_handler_llm_end.py` — on_llm_end writes a commit whose `llm_call` includes model + usage from `response.llm_output`.
   - One smoke test per framework adapter that mocks the underlying SDK and asserts a recorded `LlmCall` with non-empty `model`.

## Acceptance Criteria
- [ ] `agentgit_adapter.TARGET_VERSION == 3` and `migration_status(conn)` reports `current=3` after `run_migrations` on a v2 fixture.
- [ ] `AgentWrapper(...).record_llm_call(provider="anthropic", model="claude-opus-4-7", messages=[...], response="...", usage={...})` returns a 64-char hash and the persisted SQL row's `llm_call` column contains the JSON-serialized LlmCall.
- [ ] Canonical hash of a Python-written LlmCall commit matches the hash computed by the TS `Repository.hashObject` for the same input dict (regression test asserts on a fixed fixture).
- [ ] `AgentGitCallbackHandler.on_llm_end` produces a commit with `llmCall` populated (no longer metadata-only); existing tests for tool capture still pass.
- [ ] `_FALLBACK_SCHEMA_SQL` includes the `llm_call` column and a `schema_version` row for migration 3.
- [ ] openai-agents, autogen, and crewai adapters each have a smoke test asserting at least one LlmCall is recorded per framework run.
- [ ] `python -m pytest adapters/python adapters/langchain adapters/openai-agents adapters/autogen adapters/crewai -q` passes across Python 3.10/3.11/3.12 in CI.

## Files to Touch
- adapters/python/agentgit_adapter/migrations.py  (modify)
- adapters/python/agentgit_adapter/adapter.py  (modify)
- adapters/python/agentgit_adapter/decorator.py  (modify — add @agentgit_record_llm)
- adapters/python/agentgit_adapter/__init__.py  (modify — export new helpers)
- adapters/python/tests/test_record_llm_call.py  (create)
- adapters/python/tests/test_migration_003.py  (create)
- adapters/langchain/agentgit_langchain/handler.py  (modify)
- adapters/langchain/tests/test_handler_llm_end.py  (create)
- adapters/openai-agents/agentgit_openai_agents/adapter.py  (modify)
- adapters/openai-agents/tests/test_llm_capture.py  (create)
- adapters/autogen/agentgit_autogen/adapter.py  (modify)
- adapters/autogen/tests/test_llm_capture.py  (create)
- adapters/crewai/agentgit_crewai/adapter.py  (modify)
- adapters/crewai/tests/test_llm_capture.py  (create)

## Test Strategy
```bash
python -m pip install -e adapters/python[dev] \
                      -e adapters/langchain[dev] \
                      -e adapters/openai-agents[dev] \
                      -e adapters/autogen[dev] \
                      -e adapters/crewai[dev]
python -m pytest adapters/python adapters/langchain adapters/openai-agents \
                 adapters/autogen adapters/crewai -q
```
The Python adapter CI matrix (`.github/workflows/ci.yml:82-100`) already runs the same install + pytest command across 3.10/3.11/3.12.
