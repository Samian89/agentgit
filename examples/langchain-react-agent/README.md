# langchain-react-agent

A runnable mocked LangChain ReAct-style agent wrapped with AgentGit.

```bash
pnpm install
node --experimental-strip-types run.ts
```

The script boots a deterministic 2-step ReAct loop with two tools — `search`
(mocked) and `calculator` (numeric eval) — and records every tool call into
`.agentgit/`. After the run finishes it prints the suggested
`agentgit log -s <session-id>` command and the path to launch the Tauri UI
(`pnpm --filter @agentgit/ui dev`). The session opens in the UI exactly like
sessions produced by the standalone Python adapter or the OpenAI Agents
adapter — same step / diff / blame views.
