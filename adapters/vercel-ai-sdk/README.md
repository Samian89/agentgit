# @agentgit/adapter-vercel-ai-sdk

AgentGit adapter for the [Vercel AI SDK](https://sdk.vercel.ai/).

```js
import * as ai from "ai";
import { wrapAI } from "@agentgit/adapter-vercel-ai-sdk";
const recordingAi = wrapAI(ai);
```

`recordingAi.generateText(...)` and `recordingAi.streamText(...)` produce a
`ToolCall` commit per tool invocation in the resulting tool-call stream.
They also emit one `LlmCall` per invocation (capturing model, messages, accumulated
response text, token usage, duration, and cost estimate) via the recorder.

## Recorder Protocol

Pass a custom recorder to capture events:

```js
const recorder = {
  calls: [],
  llmCalls: [],
  record(toolCall) { this.calls.push(toolCall); },
  recordLlm(llmCall) { this.llmCalls.push(llmCall); },
};
const wrapped = wrapAI(ai, { recorder });
// after generateText/streamText + drain:
console.log(recorder.llmCalls); // RecordedLlmCall[]
```

The built-in `inMemoryRecorder()` returns `{ calls, llmCalls, record, recordLlm }`.
`recordLlm` is optional for backward compatibility — if absent the adapter skips LLM recording silently.

## Pricing Helper

```js
import { estimateCost } from "@agentgit/adapter-vercel-ai-sdk/src/pricing.mjs";

estimateCost("openai/gpt-4o", { promptTokens: 1000, completionTokens: 500 }); // number | null
estimateCost("unknown/model", usage); // null
```

Supports `openai/gpt-4o`, `openai/gpt-4o-mini`, and `anthropic/claude-*` (with sensible fallbacks). Returns `null` for unknown models. Prices are per-million-token USD estimates (illustrative).

## LlmCall shape (RecordedLlmCall)

```ts
{
  id, provider: "vercel-ai-sdk", model, messages: [{role, content}, ...],
  response: string, usage: {promptTokens, completionTokens, totalTokens} | null,
  costEstimateUsd: number | null, startedAt, completedAt, durationMs,
  status: "success"|"error", error: string | null
}
```

`streamText` special handling: `text-delta` events are concatenated into `response`; `usage` is captured from `finish` events or awaited from the `result.usage` / `result.response` promises after the stream drains.

Run smoke tests with: `node --test smoke.test.mjs`.
