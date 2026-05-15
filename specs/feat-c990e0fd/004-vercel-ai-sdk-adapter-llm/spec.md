# Vercel AI SDK Adapter — Emit LlmCall per generateText/streamText

## Goal
Extend the Vercel AI SDK adapter so each `generateText` and `streamText` invocation emits an `LlmCall` carrying the model, prompt messages, accumulated response text, usage token counts (including those that arrive only at the end of a stream), duration, and provider name. Tool-call capture is preserved; the LLM and tool-call records are independent and flow through one recorder.

## Context
- `adapters/vercel-ai-sdk/src/index.mjs` (121 lines) is the existing adapter. `generateText` wrapping is at lines 46–70; `streamText` wrapping is at lines 72–112. Both rely on a single-method `recorder.record(toolCall)` contract.
- The Vercel AI SDK ≥3.0 `generateText` return value carries `text`, `toolCalls`, `toolResults`, `usage: { promptTokens, completionTokens, totalTokens }`, `finishReason`, and `response.modelId` (per the SDK docs). `streamText` returns `{ fullStream, usage: Promise<Usage>, finishReason: Promise<string> }`; the wrapper must `await` `result.usage` (when available) after the stream completes to capture token counts that arrive after the last event.
- The smoke test pattern (`adapters/vercel-ai-sdk/smoke.test.mjs`) uses `node:test` + in-memory mocks. The mock at lines 8–33 already returns toolCalls/toolResults but no `usage`; the new tests need richer mocks.
- The recorder protocol is shared with the Anthropic adapter (see spec 003): `recorder.record(toolCall)` for tool calls and `recorder.recordLlm(llmCall)` for LLM events. The shared `inMemoryRecorder()` factory pattern stays; this adapter ships its own copy for now (matching the existing structure at lines 24–32).
- Spec 002 wires the SDK proxy's `agent.llm` auto-capture path to `wrapAI`; spec 003 establishes the same recorder.recordLlm bridge for Anthropic. Both bridges resolve to `repo.recordLlmCall` from spec 001.

## Technical Approach
1. **Extend `inMemoryRecorder()`** in `adapters/vercel-ai-sdk/src/index.mjs` to include `llmCalls: []` and a `recordLlm(call)` method. This matches the protocol described in spec 003 so both adapters can be wired through the same SDK bridge.
2. **`generateText` LLM emission**:
   - Capture `startedAt = Date.now()` before the upstream call.
   - After `await ai.generateText(params)`, build `LlmCall`:
     ```js
     {
       id: randomId(),
       provider: "vercel-ai-sdk",
       model: result.response?.modelId ?? params.model?.modelId ?? "unknown",
       messages: normalizeMessages(params.messages ?? [{ role: "user", content: params.prompt ?? "" }]),
       response: result.text ?? "",
       usage: result.usage
         ? { promptTokens: result.usage.promptTokens,
             completionTokens: result.usage.completionTokens,
             totalTokens: result.usage.totalTokens }
         : null,
       costEstimateUsd: estimateCost(model, usage),
       startedAt, completedAt, durationMs,
       status: "success", error: null,
     }
     ```
   - Call `recorder.recordLlm?.(call)` (skip silently when the recorder doesn't implement it, for backward compat).
3. **`streamText` LLM emission** — the harder case:
   - Capture `startedAt` and create a per-call `llmAccum = { response: "", usage: null }`.
   - Inside the wrapped `fullStream` generator, observe `text-delta` events and append to `llmAccum.response`; observe `finish` events and capture `usage` / `finishReason` / `model` if attached.
   - After the upstream iterator completes, also `await result.usage` and `await result.response` if either is a Promise on the original result, then build and emit the `LlmCall`.
   - The existing tool-call inflight tracking is preserved unchanged.
4. **Error handling**: when `ai.generateText` throws or when the `streamText` iterator throws, emit an LlmCall with `status: "error"`, `error: String(err)`, `response: llmAccum.response`, then re-throw.
5. **Pricing helper** at `adapters/vercel-ai-sdk/src/pricing.mjs` mirroring spec 003's approach: a small table of known Vercel-AI-routed models (`openai/gpt-4o`, `openai/gpt-4o-mini`, `anthropic/claude-*`) returning per-million-token prices; `null` for unknown.
6. **Smoke test additions** at `adapters/vercel-ai-sdk/smoke.test.mjs`:
   - generateText with `usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }` and `response: { modelId: "gpt-4o" }` produces one llmCall with the matching values.
   - streamText accumulates `text-delta` events into `llmCall.response`.
   - streamText that exposes `usage` as a Promise — the recorder still captures it after stream drain.
   - existing tool-call tests continue to pass.
7. **Update README** at `adapters/vercel-ai-sdk/README.md` to document the new recorder protocol and pricing helper.

## Acceptance Criteria
- [ ] `wrapAI({ generateText, streamText }, { recorder }).generateText(...)` produces exactly one `recorder.llmCalls` entry per call with `provider === "vercel-ai-sdk"` and `usage.totalTokens` from the upstream result.
- [ ] `wrapAI(...).streamText(...)` produces exactly one llmCall after the stream is fully drained, with `response` equal to the concatenated `text-delta` payloads and `usage` populated from the post-stream promise.
- [ ] Tool-call capture (generateText `toolCalls` and streamText `tool-call`/`tool-result` events) continues to work identically to today.
- [ ] An upstream `throw` propagates and a `status: "error"` llmCall is recorded.
- [ ] All existing smoke tests plus the new tests pass: `node --test adapters/vercel-ai-sdk/smoke.test.mjs`.
- [ ] `pricing.mjs` returns numeric estimates for at least two known model IDs and `null` for unknown.

## Files to Touch
- adapters/vercel-ai-sdk/src/index.mjs  (modify)
- adapters/vercel-ai-sdk/src/pricing.mjs  (create)
- adapters/vercel-ai-sdk/smoke.test.mjs  (modify — add tests)
- adapters/vercel-ai-sdk/README.md  (modify)

## Test Strategy
```bash
node --test adapters/vercel-ai-sdk/smoke.test.mjs
```
The smoke test file is exercised by the `js-adapters` job at `.github/workflows/ci.yml:118-129`. Local repro is one command; mocks ensure no network is required.
