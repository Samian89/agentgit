# Documentation Update — LlmCall, Adapter LLM Capture, Redaction

## Goal
Bring the user-facing documentation in `docs/` and the package READMEs in line with the new LLM-call audit-log capability so a new user can discover, configure, and verify LLM capture without reading source code. Existing docs already advertise the system as a tool-call audit log; the additions describe the LlmCall first-class type, the auto-capture path through `wrapAgentJS({ llm })`, the per-adapter capture details, the new CLI flags, and the redaction config.

## Context
- `README.md` (root, 158 lines) is the entry-point pitch. The "60-second pitch" paragraph and the feature matrix should both mention LLM call recording. The current matrix lists tool-call commit shapes as "Built" — adding an LLM-call row keeps the table honest.
- `docs/quickstart.md` walks a user from install through `agentgit log`. It should show that an LLM commit appears in `agentgit log` after wrapping an agent that uses `this.llm`.
- `docs/sdk-api.md` is the SDK reference. The `wrapAgentJS` signature, `WrapOptions`, and `WrappedAgent` are documented here — they all change in spec 002 and need to reflect the new `llm` option.
- `docs/adapters.md` (211 lines) covers the Python adapter and the LangChain handler. The Anthropic SDK, Vercel AI SDK, OpenAI Agents, AutoGen, and CrewAI adapters are NOT documented here today — this spec fills that gap *for the LLM-capture surface only*; other adapter behaviors should already be documented or are out of scope for this feature.
- `docs/cli-reference.md` documents `agentgit log`, `agentgit replay`, etc. New flags (`--llm-only`, `--tool-only`, `--full`) need to be listed.
- `docs/safety-guards.md` already documents the `guards` config block; spec 008 adds the redaction config alongside it.
- `docs/architecture.md` includes the object-store/SQLite ER-diagram description. Migration 003 (adding `llm_call` column) needs a callout so the diagram stays accurate.

## Technical Approach
1. **README.md** (root):
   - Pitch paragraph: add a sentence after "AI agents change files, call tools..." mentioning that LLM reasoning calls (prompt, response, tokens, cost) are captured too.
   - Feature matrix: add a "Built" row: "LlmCall first-class commit type with model/tokens/cost; auto-capture for Anthropic SDK, Vercel AI SDK, and Python LLM SDKs."
   - Quick example: extend the `wrapAgentJS` example to include an `llm` property and a single LLM call so a reader sees end-to-end flow.
2. **docs/quickstart.md**: add a "Capturing LLM calls" subsection showing:
   ```ts
   class Agent {
     llm = new Anthropic();
     async run(prompt: string) {
       const resp = await this.llm.messages.create({ model: "claude-opus-4-7", messages: [{ role: "user", content: prompt }] });
       return resp.content[0].text;
     }
   }
   ```
   Then a snippet of `agentgit log` output showing the new `llm: claude-opus-4-7 (N tok)` line.
3. **docs/sdk-api.md**:
   - Document the new `WrapOptions.llm` field with examples: `undefined` (auto-detect), `false` (opt out), `{ provider, client }` (explicit).
   - Add an "LlmCall" section that links to the type signature and lists each field (mirror what spec 001 codifies).
4. **docs/adapters.md**:
   - Add an "Anthropic SDK" section documenting `wrapAnthropic(client, { recorder })`, the recorder.recordLlm protocol, and the pricing helper.
   - Add a "Vercel AI SDK" section documenting `wrapAI(ai, { recorder })`, the streamText capture behavior, and the pricing helper.
   - Add a "Python LLM capture" section documenting `record_llm_call`, `@agentgit_record_llm`, and the LangChain handler's new on_llm_end behavior.
   - Add short paragraphs for the OpenAI Agents, AutoGen, and CrewAI adapters explaining what their LLM hook captures.
5. **docs/cli-reference.md**:
   - `agentgit log [--llm-only|--tool-only] [-s session]`
   - `agentgit replay <session> [--full]`
   - Example output blocks showing both tool and LLM commits in `log`, and the `LLM: model / Tokens: ... / Prompt: ... / Response: ...` block in `replay`.
6. **docs/safety-guards.md**:
   - Append a "Redaction" subsection (referenced by spec 008) that documents `llm.redaction.redactPatterns`, the `[REDACTED]` default placeholder, the `includeToolCalls` flag, and a worked example.
7. **docs/architecture.md**:
   - Update the SQLite ER-diagram paragraph: `commits` table now has `llm_call TEXT` alongside `tool_call`. Note that LlmCall and ToolCall are both embedded JSON columns rather than separate tables (matches the existing pattern).
   - Bump the `TARGET_VERSION` reference to 3.

## Acceptance Criteria
- [ ] README.md mentions LLM-call capture in the pitch and feature matrix; example shows an agent with an `llm` property.
- [ ] docs/quickstart.md has a "Capturing LLM calls" subsection with example code and expected `agentgit log` output.
- [ ] docs/sdk-api.md documents `WrapOptions.llm` and the `LlmCall` interface.
- [ ] docs/adapters.md has sections for Anthropic SDK, Vercel AI SDK, and Python LLM capture (record_llm_call + @agentgit_record_llm + LangChain handler update), plus framework adapter LLM-hook notes.
- [ ] docs/cli-reference.md documents `--llm-only`, `--tool-only`, `--full` flags with example outputs.
- [ ] docs/safety-guards.md has a "Redaction" subsection.
- [ ] docs/architecture.md mentions the `llm_call` column and `TARGET_VERSION = 3`.
- [ ] `pnpm docs:build` exits 0 (no broken links, no malformed markdown).

## Files to Touch
- README.md  (modify)
- docs/quickstart.md  (modify)
- docs/sdk-api.md  (modify)
- docs/adapters.md  (modify)
- docs/cli-reference.md  (modify)
- docs/safety-guards.md  (modify — overlaps with spec 008; coordinate by leaving the Redaction subsection to whichever ticket lands last)
- docs/architecture.md  (modify)

## Test Strategy
```bash
pnpm docs:build
```
The VitePress build catches malformed markdown, broken internal links, and missing pages. Visually verify by running `pnpm docs:dev` locally and clicking through the touched pages.
