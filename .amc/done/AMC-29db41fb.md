# AMC-29db41fb Completion Report

**Ticket:** Optional sensitive-data redaction for LLM and tool captures  
**Branch:** master (stayed on HEAD, no branch ops)  
**Phase:** build  
**Verifier:** PASS (full /check subagent trace + 248/248 core tests + 6/6 redact Python tests + manual e2e + api parity)

---

## What was built

Implemented the full scope of spec 008-redact-patterns-config:

- Added `LlmRedactionConfig` interface (enabled, redactPatterns, placeholder, includeToolCalls) + `llm?: { redaction?: LlmRedactionConfig }` to `AgentGitConfig` in core config types.
- Created `packages/core/src/redact.ts`: `validateRedactionPatterns` (clear error with pattern + path), `buildRedactor` factory (compiles `new RegExp(p,"g")` once, returns null when disabled/no patterns), `redactLlmCall` (messages[].content, response, error), `redactToolCall` (input JSON roundtrip, output string/JSON roundtrip for objects/arrays, error).
- Hooked into `Repository.init`: calls validate early so misconfig fails fast on first open.
- In `Repository.commit`: loads config (already present), builds redactor, applies redaction to llmCall/toolCall (respect includeToolCalls default true) producing effective* values **before** `objects.write(commitBody)` — hash and persisted object are always redacted. Same path covers `recordLlmCall`.
- Exported `LlmRedactionConfig` from `packages/core/src/index.ts`.
- Created `redact.test.ts` (9 tests: unit redaction, e2e commit/record, pre-hash invariant, on-disk object, init-throw, idempotent) + `redact-tool-call.test.ts` (5 tests: non-string output roundtrips, include=false).
- Added shared fixture `packages/core/src/__tests__/fixtures/redacted-llm-call.json`.
- Mirrored in Python: added `_build_redactor`, `_redact_llm_call`, `_redact_tool_call` (re.compile, same placeholder, same JSON roundtrip logic) in `adapter.py`; applied in `_record_commit` before `_hash_and_write` + DB json. Replicated helpers + integration in `agentgit_langchain/handler.py` for parity.
- Created `adapters/python/tests/test_redaction.py` (6 tests: unit, e2e via wrap_agent.record_llm_call, invalid regex, cross-lang parity via fixture + canonical JSON structure match).
- Added comprehensive "Redaction" subsection to `docs/safety-guards.md` (config, affected fields, pre-hash contract, regex caveats recommending ASCII, sk- example, independence from telemetry).
- All changes produce identical redacted canonical JSON + SHA-256 hash across TS core and Python adapters for the same inputs.

All committed to `master`. Verifier confirmed 0 issues affecting correctness.

---

## APIs, types, and interfaces other tickets may consume

**Public surface (exported, locked for api parity):**

- `export interface LlmRedactionConfig { enabled?: boolean; redactPatterns?: string[]; placeholder?: string; includeToolCalls?: boolean; }`
- `AgentGitConfig.llm?: { redaction?: LlmRedactionConfig }`
- `export type { LlmRedactionConfig } from "@agentgit/core"`

**Internal (for adapter authors / future):**
- `buildRedactor(cfg): ((s:string)=>string)|null`
- `redactLlmCall(call, redactFn)`
- `redactToolCall(tc, redactFn)`
- `validateRedactionPatterns(patterns, configPath?)` — throws with pattern in message

Python public surface unchanged; redaction is automatic when `config.json` present (same as guards).

The redaction contract (pre-hash, `[REDACTED]` sentinel, ECMAScript regex sources) is now stable for any downstream that reads `llmCall`/`toolCall` from commits.

---

## Files changed

- `packages/core/src/config.ts`
- `packages/core/src/index.ts`
- `packages/core/src/redact.ts` (new)
- `packages/core/src/repository.ts`
- `packages/core/src/__tests__/redact.test.ts` (new)
- `packages/core/src/__tests__/redact-tool-call.test.ts` (new)
- `packages/core/src/__tests__/fixtures/redacted-llm-call.json` (new)
- `adapters/python/agentgit_adapter/adapter.py`
- `adapters/langchain/agentgit_langchain/handler.py`
- `adapters/python/tests/test_redaction.py` (new)
- `docs/safety-guards.md`

**Test output (excerpt):**
- pnpm --filter @agentgit/core build: ✓ (tsc clean)
- pnpm --filter @agentgit/core test: 22 files, 248 tests passed (redact* included)
- python -m pytest adapters/python -q -k redact: 6 passed

**No ticket-update.json needed** — testCommand, filesAllowed, expectedArtifacts unchanged.

**Rules followed:** stayed on master, no destructive git, no secret reads, scoped edits, /check verifier PASS, .amc/done written.

Ready for Reviewer Agent.
