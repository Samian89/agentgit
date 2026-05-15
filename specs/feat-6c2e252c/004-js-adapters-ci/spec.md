# Add JS Adapter Smoke Tests to CI

## Goal
Ensure the two JavaScript SDK adapters (anthropic-sdk and vercel-ai-sdk) have their `node --test` smoke tests executed in CI, so that regressions in these thin integration layers are caught before merge.

## Context
The adapters/anthropic-sdk and adapters/vercel-ai-sdk packages are thin ESM wrappers around the official Anthropic and Vercel AI SDKs. Each package has:
- `package.json` with `"test": "node --test smoke.test.mjs"`
- `smoke.test.mjs` containing 2-3 TAP tests that verify the wrap function records commits
- `src/index.mjs` with the actual adapter implementation

These adapters are NOT part of the pnpm workspace (they live under `adapters/`, not `packages/`), so they are not covered by `vitest.workspace.ts` (which only configures core/cli/sdk/remote-server under packages/). They are also not Python packages, so they are outside the pytest matrix in CI.

The root CI workflow (`.github/workflows/ci.yml`) has no job or step that runs `node --test` against these two adapter directories. The adapters are listed in the user's audit as "New adapters: anthropic-sdk, vercel-ai-sdk (JS)" and the smoke tests pass locally (`node --test adapters/anthropic-sdk/smoke.test.mjs` and the vercel equivalent both exit 0 with TAP output).

Without CI coverage, a breaking change to the core SDK or to the adapter's assumptions about the upstream SDK could land undetected.

## Technical Approach
Add a new CI job (or extend an existing job) that:
1. Uses `actions/setup-node@v4` with Node 20 (matching the other JS jobs).
2. Runs `pnpm install --frozen-lockfile` (or a focused install if the adapters only need @agentgit/core + their upstream SDKs).
3. Executes the two smoke test commands:
   - `node --test adapters/anthropic-sdk/smoke.test.mjs`
   - `node --test adapters/vercel-ai-sdk/smoke.test.mjs`

The adapters import from `@agentgit/core` (the built dist), so the job must ensure core is built first (same pattern as the existing "unit" and "api-extractor" jobs). The adapters have their own `package.json` with no workspace deps, so they can be tested in isolation after core is built.

Option A (minimal): add a new job "js-adapters" after the existing unit job.
Option B (consolidation): add the two `node --test` invocations to the end of the existing "unit" job after `pnpm test`.

Option A is preferred for clarity and to keep job failure attribution obvious. The job should be non-blocking initially (or `fail-fast: false` if matrixed) but the intent is that it becomes a required check.

No changes to the adapter source or smoke tests are required.

## Acceptance Criteria
- [ ] A new CI job (or extended existing job) runs `node --test adapters/anthropic-sdk/smoke.test.mjs` and `node --test adapters/vercel-ai-sdk/smoke.test.mjs` on every PR and push to main.
- [ ] The job depends on (or includes) `pnpm --filter @agentgit/core build` so the adapters can import the built core package.
- [ ] Both smoke test files pass (3 + 2 tests respectively) and the job exits 0.
- [ ] A developer can reproduce the CI step locally with the same node + pnpm commands.

## Files to Touch
- .github/workflows/ci.yml (modify | add new "js-adapters" job or extend "unit" job with the two node --test invocations)

## Test Strategy
To verify locally (matches CI):

```bash
pnpm --filter @agentgit/core build
node --test adapters/anthropic-sdk/smoke.test.mjs
node --test adapters/vercel-ai-sdk/smoke.test.mjs
```

In CI, the new job will run after checkout + pnpm install + core build. The job should be added to the workflow such that GitHub branch protection can require it (or it can be informational initially). The existing smoke tests are self-contained and do not require network access or API keys.
