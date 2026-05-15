# AMC-7cced348 — Restore api-extractor baseline for @agentgit/core

## What I built / did
Re-ran the api-extractor baseline regeneration for `@agentgit/core` and verified that all three `api:check` invocations exit 0 on a clean tree, so the CI "API surface" job will pass and future public-API regressions will be detected.

Sequence:
1. Ran `pnpm --filter @agentgit/core api:update` — wrote a fresh `packages/core/etc/agentgit-core.api.md` (1026 lines) from the existing `dist/index.d.ts` public surface. The `dist/` artifacts from a prior successful build were intact, so a re-build was not required (the typecheck blocker in `benchmarks-shape.test.ts` had already been fixed in parallel ticket AMC-ba2c1989, commit `a06fe3a`).
2. Verified `packages/core/etc/agentgit-core.api.md` matches `packages/core/temp/agentgit-core.api.md` (the temp report api-extractor writes for diffing) — they are byte-identical, confirming the baseline is canonical.
3. Confirmed sibling ticket AMC-43ef0b4e (commit `5cd76af`) had already committed the same regenerated baseline as part of its CI work (`1026 insertions(+), 780 deletions(-)`), so my regeneration produced no further diff and `git status` is clean — no additional commit was needed.
4. Ran all four verification commands; every one exits 0:
   - `pnpm --filter @agentgit/core api:check` → "API Extractor completed successfully"
   - `pnpm --filter @agentgit/sdk api:check`  → "API Extractor completed successfully"
   - `pnpm api:check`                          → "API Extractor completed successfully" (×2)

## Files changed
None on this branch by this run. The canonical baseline file was already at the regenerated state thanks to a concurrent sibling ticket:

- `packages/core/etc/agentgit-core.api.md` — replaced (780 → 1026 lines) in commit `5cd76af` (AMC-43ef0b4e) before this ticket ran. Re-running `api:update` produced no new diff against that committed content. No semantic public-API additions or removals: same 130 `export …` symbols as the prior baseline; the line growth is from api-extractor expanding inline type signatures and re-export shapes (e.g. `FetchLike`, `RemoteClientOptions`) that were previously elided.

## APIs / types / interfaces other tickets may consume
This ticket did not change the public API surface — it only re-synchronized the api-extractor *report*. The committed baseline now reflects the canonical public surface of `@agentgit/core` as exported from `packages/core/src/index.ts` and re-exported through `dist/index.d.ts`. Downstream tickets that modify `@agentgit/core` exports (add/remove a symbol, change a signature) MUST run `pnpm --filter @agentgit/core api:update` and commit the updated `packages/core/etc/agentgit-core.api.md` in the same commit, or the "API surface" CI job will fail.

## Acceptance criteria
- [x] `pnpm --filter @agentgit/core api:check` exits 0
- [x] `pnpm --filter @agentgit/sdk api:check` exits 0
- [x] Root `pnpm api:check` exits 0
- [x] CI "API surface" job will pass on a clean checkout (baseline matches generated report)
- [x] Committed baseline matches `dist/index.d.ts` public surface
