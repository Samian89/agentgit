# Anthropic SDK Adapter — Emit LlmCall per messages.create

## Goal
Extend the Anthropic SDK adapter so every `messages.create` call records an `LlmCall` (model, input messages, response text, usage tokens, duration, provider) in addition to the existing tool-use pairing. The recorder API stays the same — a recorder may opt in to either `record(toolCall)` or `recordLlm(llmCall)` — so the existing in-memory recorder, smoke tests, and SDK integration in spec 002 keep working.

## Context
- The current adapter at `adapters/anthropic-sdk/src/index.mjs` (143 lines) wraps `client.messages.create`. Lines 102–132 are the entire `create` interceptor: it scans outbound messages for `tool_result` blocks, awaits the original call, and scans the response for `tool_use` blocks. There is no LLM-level capture today.
- The recorder protocol is the single-method `record(toolCall)` (used in `wrapAnthropic` at line 113 and `inMemoryRecorder` at line 78). We need to extend it to handle LLM events without breaking existing callers.
- The Anthropic SDK's response shape (per smoke test mock `adapters/anthropic-sdk/smoke.test.mjs:13-25`) includes `id`, `content: [{type: "text", text}, …]`, and — in real API responses — `model`, `usage: { input_tokens, output_tokens }`, and `stop_reason`. The adapter must read these and tolerate their absence (smoke test mocks lack them).
- The recorder is also used as a bridge in spec 002 (`packages/sdk/src/wrap.ts` wires `recorder.record` to `repo.recordLlmCall`). That bridge must be updated alongside this adapter.
- The smoke test pattern is `node --test adapters/anthropic-sdk/smoke.test.mjs`, already wired into CI at `.github/workflows/ci.yml:118-129`. New tests must follow the same `node:test` + `assert/strict` mocking conventions.

## Technical Approach
1. **Extend the recorder protocol**:
   ```js
   /**
    * @typedef {Object} RecordedLlmCall
    * @property {string} id
    * @property {string} provider  // "anthropic"
    * @property {string} model
    * @property {Array<{role:string,content:string}>} messages
    * @property {string} response
    * @property {{promptTokens:number, completionTokens:number, totalTokens:number}|null} usage
    * @property {number|null} costEstimateUsd
    * @property {number} startedAt
    * @property {number|null} completedAt
    * @property {number|null} durationMs
    * @property {"pending"|"success"|"error"} status
    * @property {string|null} error
    */
   ```
   `inMemoryRecorder()` gains an `llmCalls: RecordedLlmCall[]` array and a `recordLlm(call)` method. Existing `record(call)` behavior is unchanged. Callers that pass a custom recorder may implement only one of the two methods — the wrapper detects via `typeof recorder.recordLlm === "function"`.
2. **Wrap messages.create** with LLM emission:
   - Snapshot `startedAt = Date.now()` before `await original(params)`.
   - On success: extract `model = response.model ?? params.model ?? "unknown"`, `text = response.content.filter(b => b.type === "text").map(b => b.text).join("\n")`, `usage = response.usage ? { promptTokens: response.usage.input_tokens, completionTokens: response.usage.output_tokens, totalTokens: response.usage.input_tokens + response.usage.output_tokens } : null`. Normalize input `params.messages` into the canonical `{role, content}` shape (collapsing array-of-blocks content into a single string per message). Build the `RecordedLlmCall` and call `recorder.recordLlm(call)`.
   - On thrown error: still record with `status: "error"`, `error: String(err)`, `response: ""`, then re-throw so caller semantics don't change.
3. **Preserve tool-call capture**: keep the existing `tool_use`/`tool_result` pairing logic. The two recordings are independent — one `messages.create` call may emit one LlmCall plus zero-or-more tool calls. They flow through the same recorder.
4. **Cost estimate**: provide a small `estimateCost(model, usage)` helper with a hard-coded per-model table (claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 known prices). The table is intentionally conservative and easy to update; unknown models return `null`. Place in a new module `adapters/anthropic-sdk/src/pricing.mjs` so the SDK adapter (and spec 004) can share a similar pattern.
5. **Update smoke test** `adapters/anthropic-sdk/smoke.test.mjs`:
   - Existing tool-use/tool-result tests stay.
   - Add a test: a mock response with `model: "claude-opus-4-7"` and `usage: { input_tokens: 12, output_tokens: 34 }` results in `recorder.llmCalls.length === 1` with the expected fields.
   - Add a test: an error thrown by `original.create` produces a recorded `LlmCall` with `status: "error"` and the original error re-throws.
   - The existing JS-adapter CI job (`.github/workflows/ci.yml` `js-adapters`) runs this file unchanged.
6. **Update the SDK bridge** in `packages/sdk/src/wrap.ts` (the recorder built in spec 002) to forward `recordLlm` to `repo.recordLlmCall`. This spec depends on spec 001 being merged; if spec 002 has not yet landed, the adapter still works in standalone mode via `inMemoryRecorder`.

## Acceptance Criteria
- [ ] `wrapAnthropic(client, { recorder }).messages.create(...)` invokes `recorder.recordLlm(llmCall)` exactly once per successful call.
- [ ] The recorded LlmCall has `provider === "anthropic"`, `model` from response, `messages` normalized from `params.messages`, `response` equal to joined text blocks, and `usage.totalTokens === input_tokens + output_tokens`.
- [ ] If `recorder.recordLlm` is absent, the adapter is a no-op for LLM events (backward compatible with the existing in-memory recorder).
- [ ] When the upstream `messages.create` throws, a `status: "error"` LlmCall is recorded with the error message, and the exception is re-thrown to the caller.
- [ ] All existing smoke tests (3 currently) plus the new tests pass: `node --test adapters/anthropic-sdk/smoke.test.mjs`.
- [ ] `pricing.mjs` returns `null` for unknown models and a numeric estimate for at least three known Claude models.

## Files to Touch
- adapters/anthropic-sdk/src/index.mjs  (modify)
- adapters/anthropic-sdk/src/pricing.mjs  (create)
- adapters/anthropic-sdk/smoke.test.mjs  (modify — add tests)
- adapters/anthropic-sdk/README.md  (modify — document recordLlm + LlmCall shape)

## Test Strategy
```bash
pnpm --filter @agentgit/core build           # only needed if SDK bridge tests pull core
node --test adapters/anthropic-sdk/smoke.test.mjs
```
CI exercises this via the `js-adapters` job at `.github/workflows/ci.yml:118-129`. Local repro is one command and stays hermetic via the mock client pattern.
