# @agentgit/adapter-vercel-ai-sdk

AgentGit adapter for the [Vercel AI SDK](https://sdk.vercel.ai/).

```js
import * as ai from "ai";
import { wrapAI } from "@agentgit/adapter-vercel-ai-sdk";
const recordingAi = wrapAI(ai);
```

`recordingAi.generateText(...)` and `recordingAi.streamText(...)` produce a
`ToolCall` commit per tool invocation in the resulting tool-call stream.
Sessions open identically to other AgentGit sessions in the Tauri UI.

Run smoke tests with: `node --test smoke.test.mjs`.
