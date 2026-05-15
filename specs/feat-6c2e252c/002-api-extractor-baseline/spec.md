# Restore api-extractor Baseline for @agentgit/core

## Goal
Ensure `pnpm --filter @agentgit/core api:check` exits 0 in CI by regenerating and committing the canonical API report baseline, so that future public-API changes are caught as regressions rather than silently passing with a stale baseline.

## Context
The packages/core and packages/sdk both configure API Extractor via `api-extractor.json` with `apiReport.enabled: true` and `reportFolder: "<projectFolder>/etc/"`. The generated report files are `etc/agentgit-core.api.md` and `etc/agentgit-sdk.api.md`. The root package.json wires `api:check` and `api:update` scripts that invoke `api-extractor run` and `api-extractor run --local` respectively. The CI workflow has a dedicated "api-extractor" job (lines 102-119) that builds core + sdk and runs `pnpm api:check`.

Currently, `pnpm --filter @agentgit/sdk api:check` exits 0, but `pnpm --filter @agentgit/core api:check` exits 1 with the warning: "You have changed the API signature for this project. Please copy the file 'temp/agentgit-core.api.md' to 'etc/agentgit-core.api.md'". This means the committed baseline in `packages/core/etc/agentgit-core.api.md` is out of sync with the current public exports in `packages/core/src/index.ts` (and the types it re-exports from internal modules). The `packages/core/etc/agentgit-core.api.md` file exists and is committed (30+ lines), but its content no longer matches the generated temp report.

Without a matching baseline, `api:check` cannot detect public-API regressions; the CI job will always fail until someone manually updates the baseline.

## Technical Approach
1. Run `pnpm --filter @agentgit/core build` to ensure dist/ is up to date.
2. Run `pnpm --filter @agentgit/core api:update` (which invokes `api-extractor run --local`). This writes the fresh report to `packages/core/etc/agentgit-core.api.md` (overwriting the stale baseline) and also writes a temp copy.
3. Inspect the diff of `packages/core/etc/agentgit-core.api.md` to confirm the changes are legitimate public-API updates (not accidental removals or signature changes that would break semver).
4. Commit the updated baseline file.
5. Verify both `pnpm --filter @agentgit/core api:check` and `pnpm --filter @agentgit/sdk api:check` exit 0.
6. The CI "API surface" job should then pass cleanly.

No code changes are required; this is purely a baseline synchronization task. The `api-extractor.json` for core is correct and does not need modification.

## Acceptance Criteria
- [ ] `pnpm --filter @agentgit/core api:check` exits 0 with "API Extractor completed successfully".
- [ ] `pnpm --filter @agentgit/sdk api:check` continues to exit 0 (unchanged).
- [ ] The root `pnpm api:check` (which runs both) exits 0.
- [ ] The CI "API surface" job passes on a clean checkout + build.
- [ ] The committed `packages/core/etc/agentgit-core.api.md` matches the report generated from the current `dist/index.d.ts` public surface.

## Files to Touch
- packages/core/etc/agentgit-core.api.md (modify | replace stale baseline with freshly generated report via api:update)

## Test Strategy
Run the exact commands the CI job and root scripts use:

```bash
pnpm --filter @agentgit/core build
pnpm --filter @agentgit/core api:update
pnpm --filter @agentgit/core api:check
pnpm --filter @agentgit/sdk api:check
pnpm api:check
```

After the update, `git diff packages/core/etc/agentgit-core.api.md` should show only the expected API report diff (additions, removals, or signature changes that are intentional). The CI api-extractor job in `.github/workflows/ci.yml` (lines 115-119) will then pass.
