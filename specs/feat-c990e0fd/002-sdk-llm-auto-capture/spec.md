# wrapAgentJS Auto-Capture of agent.llm Property

## Goal
Extend the TypeScript SDK so that, when a wrapped agent exposes an `llm` property (an Anthropic, OpenAI, or Vercel AI SDK client), calls made through that property are auto-captured as `LlmCall` commits via the new core `Repository.recordLlmCall()` plumbing. The existing tool-call proxy behavior is preserved; this is an additive surface so the documented usage in the README (`wrapAgentJS(new Agent(), …)`) continues to work without change for agents that don't expose `llm`.

## Context
- `packages/sdk/src/wrap.ts` is the entire wrapAgentJS implementation (203 lines). The `Proxy` `get` trap (lines 80–199) treats every function on the target except `run` and the `PASS_THROUGH_PROPS` set as a tool call and records via `repo.commit({ toolCall, … })`. `run` is special-cased to commit the prompt then call the underlying function with the proxy bound as `this`.
- `packages/sdk/src/types.ts` declares `AgentLike { run(prompt: string): Promise<unknown>; [key: string]: unknown }` and the public `WrapOptions` / `WrappedAgent<T>` shapes. The new behavior is opt-in by virtue of detecting `agent.llm`; no new option is required for the auto-detect path, but a `WrapOptions.llm` escape hatch should let callers tune it.
- The existing Anthropic-SDK and Vercel-AI-SDK wrappers live in `adapters/anthropic-sdk/src/index.mjs` and `adapters/vercel-ai-sdk/src/index.mjs`. Specs 003 and 004 add LlmCall emission to those wrappers; **this spec must reuse them** by importing their `wrapAnthropic` / `wrapAI` exports rather than duplicating provider-specific knowledge in the SDK.
- The api-extractor baseline at `packages/sdk/etc/agentgit-sdk.api.md` is the lock-file for the SDK public surface; any new exported types (e.g. `LlmAutoCaptureOptions`) regenerate this file.

## Technical Approach
1. **Detect `agent.llm`** inside `wrapAgentJS`. After `repo`/`session` are constructed (`wrap.ts:43-48`), inspect `agent.llm`:
   - If absent or `null`, behave exactly as today.
   - If present and shaped like an Anthropic client (`agent.llm.messages?.create`), wrap with `wrapAnthropic` from `@agentgit/adapter-anthropic-sdk` and inject a recorder that calls `repo.recordLlmCall(...)`.
   - If present and shaped like a Vercel AI module (`agent.llm.generateText` or `agent.llm.streamText`), wrap with `wrapAI` similarly.
   - Otherwise, leave `agent.llm` untouched but emit a single `console.warn` (gated by `AGENTGIT_DEBUG=1` env to avoid noise — checked once at wrap time).
   The wrapped `llm` replaces `agent.llm` on the proxy target so user code continues to call `this.llm.messages.create(...)` unchanged.
2. **Recorder bridge** — adapters expose a `recorder.record(call)` callback (see `adapters/anthropic-sdk/src/index.mjs:74-82`). The SDK builds an adapter recorder whose `record` materializes the adapter's recorded shape into a full core `LlmCall` (filling `provider`, `id`, computing `durationMs = completedAt - startedAt`) and calls `repo.recordLlmCall({ ... })`. The recorded commit's parent is `parentHash` (the same chain head used by tool calls), and the returned hash advances `parentHash` so LLM and tool commits interleave in a single linear history.
3. **`WrapOptions.llm`** (new optional field):
   ```ts
   interface WrapOptions {
     ...
     llm?:
       | false                    // disable auto-capture even if agent.llm exists
       | { provider: "anthropic" | "vercel-ai-sdk"; client?: unknown }  // explicit override
   }
   ```
   `false` short-circuits detection. Explicit `{ provider, client }` lets a caller wrap a client that's not on `agent.llm` (e.g. a module-level singleton). Default remains "auto-detect".
4. **Avoid circular dep**: `@agentgit/sdk` already depends on `@agentgit/core`. Add `@agentgit/adapter-anthropic-sdk` and `@agentgit/adapter-vercel-ai-sdk` as `workspace:*` peer/devDependencies. Use dynamic `await import("@agentgit/adapter-anthropic-sdk")` inside `wrapAgentJS` so a project that doesn't install both adapters does not fail to load the SDK — only the unused branch will throw if invoked, and the warning explains how to install.
5. **Update `WrappedAgent`** in `packages/sdk/src/types.ts` to leave the typed `llm` field as-is (it's a passthrough); no type-level surgery required — the proxy mutation is runtime-only.
6. **Tests** at `packages/sdk/src/__tests__/llm-auto-capture.test.ts`:
   - Mocked Anthropic-shaped object: `await wrapped.run(...)` followed by `wrapped.llm.messages.create(...)` writes an `LlmCall` commit (verified via `wrapped.agentgit.repo.log(sessionId)`).
   - Mocked Vercel-AI-shaped object: `await wrapped.llm.generateText(...)` writes an `LlmCall` commit with the model and usage from the mocked response.
   - `llm: false` opt-out: no LlmCall commits are written.
   - Tool-call interception continues to work alongside an `llm` property (regression: existing `wrap.test.ts` scenarios still pass).
7. **Regenerate** `packages/sdk/etc/agentgit-sdk.api.md` to pick up the new `LlmAutoCaptureOptions` / `WrapOptions.llm` field.

## Acceptance Criteria
- [ ] An agent whose constructor sets `this.llm = mockAnthropicClient()` and calls `this.llm.messages.create(...)` inside `run` produces at least one commit whose `llmCall.provider === "anthropic"` and whose `llmCall.model` matches the mock response.
- [ ] An agent with `this.llm = mockVercelAiModule()` calling `this.llm.generateText({ ... })` produces at least one commit whose `llmCall.provider === "vercel-ai-sdk"`, with `usage.totalTokens` from the mocked response.
- [ ] Passing `wrapAgentJS(agent, { llm: false })` writes zero LlmCall commits even when `agent.llm` is set.
- [ ] All existing `packages/sdk` tests pass; tool-call interception is unaffected.
- [ ] `pnpm --filter @agentgit/sdk api:check` exits 0 with the regenerated baseline committed.
- [ ] `wrapAgentJS` does not crash when `@agentgit/adapter-anthropic-sdk` is not installed, as long as the user does not attempt to use the Anthropic branch.

## Files to Touch
- packages/sdk/src/wrap.ts  (modify)
- packages/sdk/src/types.ts  (modify — add `llm?` option)
- packages/sdk/package.json  (modify — add adapter deps)
- packages/sdk/etc/agentgit-sdk.api.md  (modify — regenerated)
- packages/sdk/src/__tests__/llm-auto-capture.test.ts  (create)

## Test Strategy
```bash
pnpm --filter @agentgit/core build
pnpm --filter @agentgit/sdk build
pnpm --filter @agentgit/sdk test
pnpm --filter @agentgit/sdk api:update
pnpm api:check
```
The new test file uses in-memory mocks (same approach as `adapters/anthropic-sdk/smoke.test.mjs` and `adapters/vercel-ai-sdk/smoke.test.mjs`) so the SDK test stays hermetic and offline.
