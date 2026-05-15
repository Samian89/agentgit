# @agentgit/adapter-anthropic-sdk

AgentGit adapter for the [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript).

```js
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "@agentgit/adapter-anthropic-sdk";
const client = wrapAnthropic(new Anthropic());
```

Each `tool_use` / `tool_result` round-trip in a `messages.create` call is
recorded as one AgentGit `ToolCall` commit. Sessions opened by this adapter
render identically to other AgentGit sessions in the Tauri UI.

Run smoke tests with: `node --test smoke.test.mjs`.
