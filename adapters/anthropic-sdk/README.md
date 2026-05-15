# @agentgit/adapter-anthropic-sdk

AgentGit adapter for the [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript).

```js
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "@agentgit/adapter-anthropic-sdk";
const client = wrapAnthropic(new Anthropic());
```

Each `tool_use` / `tool_result` round-trip in a `messages.create` call is
recorded as one AgentGit `ToolCall` commit. In addition, every `messages.create`
emits exactly one `LlmCall` (provider `"anthropic"`) via the optional
`recorder.recordLlm(llmCall)` hook.

## Recorder protocol

Pass a recorder that implements one or both methods:

```js
const recorder = {
  calls: [],
  llmCalls: [],
  record(toolCall) { this.calls.push(toolCall); },
  recordLlm(llmCall) { this.llmCalls.push(llmCall); },
};
const client = wrapAnthropic(new Anthropic(), { recorder });
```

- `record(toolCall)` — unchanged ToolCall shape (id, name, input, output, startedAt, completedAt, status, error)
- `recordLlm(llmCall)` — new LlmCall shape:

```js
{
  id: string,
  provider: "anthropic",
  model: string,
  messages: Array<{ role: "system"|"user"|"assistant"|"tool", content: string }>,
  response: string,           // joined text blocks
  usage: { promptTokens, completionTokens, totalTokens } | null,
  costEstimateUsd: number | null,
  startedAt: number,
  completedAt: number | null,
  durationMs: number | null,
  status: "pending"|"success"|"error",
  error: string | null
}
```

`inMemoryRecorder()` now exposes both `calls` and `llmCalls` arrays plus both methods.

Cost estimates for known models (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`) are provided by `pricing.mjs:estimateCost(model, usage)`; unknown models yield `null`.

Run smoke tests with: `node --test smoke.test.mjs`.
