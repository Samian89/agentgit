# CLI `agentgit log` and `agentgit replay` — Render LlmCall Commits

## Goal
Make LLM commits visible in the two read-side CLI commands. `agentgit log` shows them interleaved with tool calls using a distinct prefix and inline summary (model + total tokens). `agentgit replay` includes prompt + response text for each LLM commit step, plus token/cost lines, so a user can walk through what the agent thought as well as what it did.

## Context
- `packages/cli/src/commands/log.ts` (40 lines) fetches commits via `repo.log(sessionId)` and delegates rendering to `printLog` in `packages/cli/src/pretty-printer.ts:18-35`. The current render is:
  ```
  ${YELLOW}${shortHash(hash)}${RESET} ${DIM}${timestamp}${RESET} ${CYAN}[sessionName]${RESET}
      ${message}
      ${DIM}tool: ${toolCall.name} (${toolCall.status})${RESET}
  ```
  There is no LlmCall branch yet.
- `packages/cli/src/commands/replay.ts` (51 lines) iterates commits and prints a per-step block with `Tool:`, `Input:`, `Output:`, `Status:` lines. There is no equivalent block for an LLM call.
- The `Commit.llmCall` field is added by spec 001; this spec consumes it from a regular `Commit` object — no DB-level changes are required here.
- The CLI's existing color palette (`pretty-printer.ts:3-8`) defines `RESET`, `GREEN`, `RED`, `YELLOW`, `CYAN`, `DIM`. Adding a `MAGENTA` for the `llm:` prefix keeps the change small and matches the existing style.
- The CLI is tested via `packages/cli/src/__tests__/` (see existing log/replay tests) and end-to-end via `pnpm test:integration` (`packages/cli` exposes a `test:integration` script). New tests should follow the same vitest snapshot patterns already used in that test directory.

## Technical Approach
1. **Extend `printLog`** at `packages/cli/src/pretty-printer.ts:18-35`:
   - Keep the existing tool-call branch.
   - After it, add:
     ```ts
     if (c.llmCall) {
       const tokenStr = c.llmCall.usage
         ? `${c.llmCall.usage.totalTokens} tok`
         : "? tok";
       const costStr = c.llmCall.costEstimateUsd !== null
         ? ` ~$${c.llmCall.costEstimateUsd.toFixed(4)}`
         : "";
       console.log(`    ${DIM}${MAGENTA}llm: ${c.llmCall.model} (${tokenStr}${costStr})${RESET}`);
     }
     ```
   - Both branches may render if a commit ever ends up with both (rare; future-proof).
2. **`agentgit log` filter flag**: add `--llm-only` and `--tool-only` to `packages/cli/src/commands/log.ts` so users can filter the timeline. Default is "show everything". Implementation: filter `allCommits` after fetch.
3. **Extend replay** at `packages/cli/src/commands/replay.ts:28-46`:
   - Keep the tool-call block.
   - Add an `else if (commit.llmCall)` block:
     ```
     LLM: ${tc.model} (${tc.provider})
       Tokens: ${promptTokens} prompt / ${completionTokens} completion / ${totalTokens} total
       Cost:   ~$${costEstimateUsd.toFixed(4)}     // omitted when null
       Duration: ${durationMs}ms
       Prompt:
         <indented messages — last user turn truncated to 500 chars unless --full>
       Response:
         <indented response — truncated to 500 chars unless --full>
       Status: ${status}
     ```
   - Add a `--full` option to `replayCommand` so users can opt out of truncation; default is truncated for log-friendly output.
4. **Update CLI tests** under `packages/cli/src/__tests__/`:
   - `printLog` renders `llm:` prefix and total tokens for LlmCall-only commits.
   - `printLog` renders both `tool:` and `llm:` lines when the same commit carries both.
   - `replayCommand` outputs `LLM:`, `Tokens:`, `Prompt:`, `Response:` sections for LLM commits.
   - `--full` flag bypasses truncation; default truncates at 500 chars.
   - `--llm-only` / `--tool-only` filter `log` output correctly.
5. **Help text** in `packages/cli/src/index.ts` — register the new options on the `log` and `replay` commands so `agentgit log --help` and `agentgit replay --help` document them.

## Acceptance Criteria
- [ ] `agentgit log` after a session containing both tool and LLM commits shows both kinds, with `tool: <name> (<status>)` and `llm: <model> (<N> tok ~$X.XXXX)` lines respectively.
- [ ] `agentgit log --llm-only` hides commits whose `llmCall` is null; `--tool-only` hides commits whose `toolCall` is null.
- [ ] `agentgit replay <session>` prints a per-step block including `LLM:`, `Tokens:`, `Prompt:`, `Response:`, `Status:` for each LLM commit and the existing `Tool:` / `Input:` / `Output:` / `Status:` block for tool commits.
- [ ] `agentgit replay <session> --full` does not truncate prompt or response text; default output truncates at 500 chars with a trailing `…` indicator.
- [ ] All new and existing tests pass: `pnpm --filter @agentgit/cli test` and `pnpm --filter @agentgit/cli test:integration`.

## Files to Touch
- packages/cli/src/pretty-printer.ts  (modify)
- packages/cli/src/commands/log.ts  (modify)
- packages/cli/src/commands/replay.ts  (modify)
- packages/cli/src/index.ts  (modify — register new flags)
- packages/cli/src/__tests__/pretty-printer.test.ts  (modify or create)
- packages/cli/src/__tests__/replay.test.ts  (modify or create)

## Test Strategy
```bash
pnpm --filter @agentgit/core build
pnpm --filter @agentgit/cli build
pnpm --filter @agentgit/cli test
pnpm --filter @agentgit/cli test:integration
```
The integration test should construct a real `.agentgit` repo with at least one tool commit and one LLM commit (via the new `Repository.recordLlmCall` from spec 001) and assert the CLI output strings.
