# CI Test Matrix Expansion for Adapters, Remote Server, and Web Viewer

## Goal
Make every adapter (Python and JS) and supporting package (remote-server, web-viewer) execute its tests inside the same CI runs and `pnpm test` commands that guard the rest of the repository, so that regressions in the "expanded adapter coverage" and remote protocol cannot land undetected.

## Context
`vitest.workspace.ts` only lists core, cli, and sdk. The GitHub Actions `ci.yml` "unit" job therefore only runs those three via `pnpm test`. The "python" job installs and pytest's only `adapters/python` + `adapters/langchain`. The "api-extractor" and "bench" jobs are narrow. `release.yml` only publishes two Python packages to PyPI. JS adapters live under `adapters/{anthropic-sdk,vercel-ai-sdk}/` and use `node --test smoke.test.mjs` (their package.json "test" script). `packages/remote-server/` has a full vitest roundtrip suite and `vitest.config.ts` but is never invoked from root. `packages/web-viewer/` has zero tests. Subagent exploration of all seven adapters, remote-server/server.ts + tests/roundtrip.test.ts, web-viewer/src/*, ci.yml:82-100, release.yml:78-117, and vitest.workspace.ts confirmed the exact missing matrix entries and the sys.path pattern used by the three new Python adapters.

The remote protocol (docs/remote-protocol.md) and bundle web viewer are listed as "Built" in README and architecture, yet their test surfaces are invisible to the gate that the rest of the project uses.

## Technical Approach
1. **vitest.workspace.ts** (root): add two new workspace projects for remote-server (already has vitest.config) and (optionally) a no-op or future web-viewer entry. Keep ui excluded (Tauri Rust requirement).
2. **.github/workflows/ci.yml**:
   - In "unit" job, after the existing `pnpm test`, add a step that runs the JS adapter smokes: `node --test adapters/anthropic-sdk/smoke.test.mjs && node --test adapters/vercel-ai-sdk/smoke.test.mjs`.
   - Extend the "python" matrix job (or add a follow-up job) to also `pip install -e adapters/openai-agents[dev]`, `autogen[dev]`, `crewai[dev]` (order: python first so sys.path hacks in their conftest.py find the sibling) then `pytest adapters/openai-agents adapters/autogen adapters/crewai -q`.
   - In the "bench" or a new lightweight job, ensure `pnpm --filter @agentgit/remote-server test` runs (or fold into unit via workspace).
3. **.github/workflows/release.yml**: add two more "publish-pypi-*" jobs (after langchain) that build and publish the three new Python adapters using the same `pypa/gh-action-pypi-publish` pattern. Keep them private=false in future if they are to be public; today they can stay behind the same trusted-publishing OIDC.
4. **No change** to the three new Python adapters' pyproject.toml here (that is 005). The CI change only adds the install + pytest lines; the adapters must be installable first.
5. For web-viewer: add a one-line "typecheck + build only" verification in the existing typecheck job (already does `pnpm --filter @agentgit/web-viewer build` which runs tsc --noEmit) — sufficient because it currently has no test suite.

All commands already exist in individual package.json scripts; the spec only wires them into the shared CI matrix.

## Acceptance Criteria
- [ ] `pnpm test` (after workspace edit) runs remote-server tests and reports them under a "remote-server" project name.
- [ ] The GitHub "Python" job matrix output shows 5 adapter trees collected and passing (python, langchain, openai-agents, autogen, crewai).
- [ ] `node --test adapters/anthropic-sdk/smoke.test.mjs && node --test adapters/vercel-ai-sdk/smoke.test.mjs` is executed in the "Unit tests" CI job and appears in the log.
- [ ] `pnpm --filter @agentgit/remote-server test` succeeds in CI.
- [ ] release.yml contains publish steps for the three new PyPI packages (even if they remain private for now).
- [ ] No existing test count or timing regression >10 % on the GitHub runners.

## Files to Touch
- vitest.workspace.ts (modify | add remote-server workspace entry)
- .github/workflows/ci.yml (modify | extend python matrix, add JS adapter node --test step, remote-server filter)
- .github/workflows/release.yml (modify | add three publish-pypi-* jobs for openai-agents, autogen, crewai following the langchain pattern)
- adapters/openai-agents/pyproject.toml (read-only | reference for install command)
- packages/remote-server/vitest.config.ts (read-only | confirms it is a valid vitest root)
- packages/web-viewer/package.json (read-only | confirms build already runs typecheck)

## Test Strategy
The verification commands are exactly the ones that will run in CI after the change:

```bash
# local equivalent of the expanded unit job
pnpm test
node --test adapters/anthropic-sdk/smoke.test.mjs
node --test adapters/vercel-ai-sdk/smoke.test.mjs
pnpm --filter @agentgit/remote-server test

# local equivalent of the python job (requires python 3.10+)
python -m pip install -e adapters/python[dev] -e adapters/langchain[dev] \
  -e adapters/openai-agents[dev] -e adapters/autogen[dev] -e adapters/crewai[dev]
python -m pytest adapters/python adapters/langchain adapters/openai-agents adapters/autogen adapters/crewai -q
```

These are the same commands listed in the user query's Step 1 audit list. After the spec is implemented, re-running the audit commands must produce green output for every adapter and remote-server. The change is isolated to CI configuration and one workspace file; a single engineer can land it in one focused session once 005 (packaging) has landed.