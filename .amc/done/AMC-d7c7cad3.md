# AMC-d7c7cad3 Completion Report

**Ticket:** Anthropic SDK adapter LlmCall emission  
**Branch:** master (stayed on HEAD, no branch ops)  
**Phase:** build  
**Verifier:** PASS (after fixes for exactOptionalPropertyTypes in bridge + artifact + commit)

---

## What was built

Implemented the full scope of spec 003-anthropic-adapter-llm:

- Created `adapters/anthropic-sdk/src/pricing.mjs` with hard-coded `PRICES` table for `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5` (per-million input/output) and exported `estimateCost(model, usage)` that returns numeric cost or `null` for unknown models / missing usage. Uses conservative Anthropic-like rates and rounds to 6 decimals.
- Extended `adapters/anthropic-sdk/src/index.mjs`:
  - Added `RecordedLlmCall` JSDoc typedef matching the spec shape (id, provider, model, messages, response, usage, costEstimateUsd, startedAt/completedAt/durationMs, status, error).
  - Extended `inMemoryRecorder()` to expose `llmCalls: RecordedLlmCall[]` and `recordLlm(call)` (existing `record`/`calls` unchanged for tool calls).
  - Updated `wrapAnthropic` to snapshot `startedAt = Date.now()` before the original call.
  - On success: extract `model = response.model ?? params.model ?? "unknown"`, joined text response from content blocks, normalize `usage` from `input_tokens`/`output_tokens`, call `estimateCost`, normalize input messages, build full `RecordedLlmCall` with status success, and invoke `recorder.recordLlm(llmCall)` exactly once if the method exists (`typeof` guard).
  - Added internal `normalizeMessages()` that collapses string or array-of-blocks content into `{role, content: string}` (with `[tool_use:...]`, `[tool_result:...]` markers for non-text blocks).
  - On thrown error from original: still build and record a `status: "error"` LlmCall (response:"", error:String(err)), then re-throw so caller semantics unchanged.
  - Tool-use/tool-result pairing logic left completely untouched and independent (one create() may produce 1 LlmCall + 0..N ToolCalls via same recorder).
- Updated `adapters/anthropic-sdk/smoke.test.mjs`: existing 3 tool tests continue to pass unchanged (they now incidentally populate `llmCalls` but asserts only touch `.calls`). Added:
  - Success test: mock with `model: "claude-opus-4-7"`, `usage: {input_tokens:12, output_tokens:34}` → `recorder.llmCalls.length===1`, all fields (provider, model, response, usage.totalTokens, costEstimateUsd numeric>0, status, normalized messages) match.
  - Error test: upstream throw → records error LlmCall, original exception re-thrown, fields correct.
- Updated `adapters/anthropic-sdk/README.md` with full recorder protocol documentation, `RecordedLlmCall` shape example, pricing note, and usage snippet.
- Updated `packages/sdk/src/wrap.ts` (SDK bridge per spec §6): added `createLlmRecorderBridge(repo, sessionId, getParent, setParent)` that returns a recorder object whose `recordLlm(adapterLlmCall)` converts the adapter shape into `LlmCallInput`, calls `repo.recordLlmCall(...)`, and advances `parentHash` for linear commit history. Includes `record()` no-op for shape compat. Uses conditional spreads to satisfy `exactOptionalPropertyTypes: true`. (Full `agent.llm` auto-detect is deferred to sibling spec 002; this ticket only supplies the forwarder.)
- All changes committed to `master` (clean commit after verifier fixes).

---

## Acceptance criteria met

- `wrapAnthropic(client, { recorder }).messages.create(...)` invokes `recorder.recordLlm(llmCall)` exactly once per successful call.
- Recorded LlmCall has `provider === "anthropic"`, `model` from response, `messages` normalized, `response` = joined text, `usage.totalTokens` correct, `costEstimateUsd` numeric for known models.
- If `recordLlm` absent → no-op (backward compat with old inMemoryRecorder).
- Upstream throw → status:error LlmCall recorded + exception re-thrown.
- `node --test adapters/anthropic-sdk/smoke.test.mjs` → 5/5 PASS (3 original + 2 new).
- `pricing.mjs` returns null for unknown, numeric for the three Claude models.
- SDK bridge updated; typecheck clean.

---

## Files changed

- `adapters/anthropic-sdk/src/pricing.mjs` (new)
- `adapters/anthropic-sdk/src/index.mjs` (modified)
- `adapters/anthropic-sdk/smoke.test.mjs` (modified)
- `adapters/anthropic-sdk/README.md` (modified)
- `packages/sdk/src/wrap.ts` (modified)

(Also created `.amc/done/AMC-d7c7cad3.md` and one git commit.)

---

## APIs, types, and interfaces other tickets may consume

**Public surface (adapters):**

- `inMemoryRecorder()` now returns `{ calls, llmCalls, record, recordLlm }`
- `wrapAnthropic(client, { recorder?: { record?, recordLlm? } })` — the `recordLlm` hook receives `RecordedLlmCall`
- `export function estimateCost(model: string, usage: LlmUsage | null): number | null` from `./pricing.mjs`

**SDK bridge (for spec 002 and consumers of `@agentgit/sdk`):**

- `export function createLlmRecorderBridge(repo, sessionId, getParent, setParent)` → recorder with `recordLlm(adapterLlmCall)` that calls `repo.recordLlmCall(LlmCallInput)` and updates parent hash.
- Re-uses core `LlmCallInput` / `recordLlmCall` (from AMC-ef730862) — no new core surface.

**No changes to core types or api-extractor baseline** (additive only; existing `LlmCall`, `LlmUsage`, `LlmMessage`, `Repository.recordLlmCall` consumed as-is).

---

## Test output (exact command)

```
node --test adapters/anthropic-sdk/smoke.test.mjs
# 5 tests, all pass (including new LlmCall success + error cases)
```

`packages/sdk typecheck` (tsc --noEmit) also clean after bridge fix.

All committed to `master` (one clean commit after verifier round; verified via `git log --oneline -1`).

---

## Notes for downstream tickets (004 Vercel, 002 SDK auto-capture, etc.)

- The `pricing.mjs` + `estimateCost` pattern is mirrored in vercel-ai-sdk (spec 004).
- `createLlmRecorderBridge` is the reusable forwarder for both Anthropic and Vercel adapters inside `wrapAgentJS`.
- The adapter is fully standalone via `inMemoryRecorder` (no core dep needed for smoke / direct use).
- Message normalization and error handling are robust for mixed tool/LLM conversations.

Reviewer flags on AMC-d7c7cad3: approved after fix iteration.
