# Documentation — Cover All Seven Adapters in adapters.md

## Goal
Update the public documentation so that every adapter that ships in the repository (the original two plus the five "new" ones listed as Built) has at least a one-paragraph install + usage example, preventing users from discovering the new adapters only via source or smoke tests.

## Context
`docs/adapters.md` currently contains detailed sections only for the Python base adapter and the LangChain callback handler. The three new Python adapters and the two JS adapters have README.md files inside their directories but are never mentioned in the central docs site that VitePress builds from `docs/`. The subagent that read the full adapters.md (and cross-referenced every adapter README) confirmed the omission. The top-level README feature matrix and architecture diagram also still list only the original two Python adapters.

Because the adapters are the primary on-ramp for users, incomplete docs is a polish defect even though the code is present.

## Technical Approach
1. In `docs/adapters.md`, after the existing LangChain section, add three short subsections (one each for openai-agents, autogen, crewai) that mirror the minimal pattern already used by the Python adapter:
   - pip install line (once 005 lands, `pip install agentgit-openai-agents`)
   - one code snippet showing the `wrap_*` call
   - note that they delegate to the core `agentgit-adapter` and therefore honour the same guards + `.agentgit/config.json`.
2. Add a final "JavaScript thin adapters" section for anthropic-sdk and vercel-ai-sdk:
   - npm install line (they remain private for now, so point to the monorepo path or note "experimental")
   - one import + `wrapAnthropic` / `wrapAI` example
   - explicit call-out that they currently only provide an in-memory recorder and must be paired with a persistence layer or the TypeScript SDK for full AgentGit semantics.
3. Update the "Adapter" row in the Feature Matrix table in `docs/index.md` and `README.md` to say "7 adapters (Python x5, JS x2)" with a link back to adapters.md.
4. Keep the existing depth for python + langchain; the new sections are intentionally one-screen each.

All examples can be copy-pasted from the per-adapter README.md files that already exist.

## Acceptance Criteria
- [ ] `pnpm docs:build` succeeds and the generated site contains headings for all five new Python adapters and the two JS adapters.
- [ ] Running the docs dev server locally (`pnpm docs:dev`) shows the new sections under "Adapters".
- [ ] The top-level README and docs/index.md feature matrices mention the expanded count (or at least link to the adapters page).
- [ ] No existing content for python/langchain is removed or altered.

## Files to Touch
- docs/adapters.md (modify | append 5 short adapter sections + JS note)
- docs/index.md (modify | update Feature Matrix "Adapters" row)
- README.md (modify | update the one-sentence adapter mention in the 60-second pitch or Feature Matrix)
- adapters/openai-agents/README.md (read-only | source of the minimal example)
- adapters/autogen/README.md, adapters/crewai/README.md, adapters/anthropic-sdk/README.md, adapters/vercel-ai-sdk/README.md (read-only)

## Test Strategy
The documentation build command already wired at the root:

```bash
pnpm docs:build          # must exit 0; inspect the generated .vitepress/dist for the new headings
pnpm docs:dev            # manual smoke: open http://localhost:5173/adapters and confirm all seven adapters appear
```

These commands are the same ones documented in the README "Run the docs site locally" section and are run as part of any docs-oriented PR. A single engineer can edit the markdown, run the build, and verify the headings in one focused session. No code or test changes are required.