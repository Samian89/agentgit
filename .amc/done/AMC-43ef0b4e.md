# AMC-43ef0b4e — Add JS SDK adapter smoke tests to CI

## What I built
Added a new GitHub Actions job `js-adapters` (name: "JS SDK adapters (smoke)") to `.github/workflows/ci.yml` that runs the `node --test` smoke suites for both JavaScript SDK adapters on every PR and push to `main`.

The job:
1. Checks out the repo, sets up pnpm 9 + Node 20 (matching the other JS jobs).
2. Runs `pnpm install --frozen-lockfile`.
3. Builds `@agentgit/core` (mirrors the pre-build pattern used by `unit` and `api-extractor`, and keeps the local repro identical to CI even though the smoke tests are currently self-contained).
4. Runs each adapter's smoke test in its **own step**, so a CI failure points at the specific adapter that broke:
   - `Anthropic SDK adapter smoke test` → `node --test adapters/anthropic-sdk/smoke.test.mjs`
   - `Vercel AI SDK adapter smoke test` → `node --test adapters/vercel-ai-sdk/smoke.test.mjs`

## Acceptance criteria
- [x] CI job executes both `node --test` smoke commands after core build.
- [x] All 5 smoke tests (3 anthropic + 2 vercel) pass — verified locally with the ticket's `testCommand`.
- [x] Reproducible locally with the same commands: `pnpm --filter @agentgit/core build && node --test adapters/anthropic-sdk/smoke.test.mjs && node --test adapters/vercel-ai-sdk/smoke.test.mjs`.
- [x] Failure attributable to a specific adapter — each adapter runs in its own named step.

## Files changed
- `.github/workflows/ci.yml` — added `js-adapters` job between the `python` and `api-extractor` jobs.

## Test output (local)
```
TAP version 13
# anthropic-sdk: ok 1..3, pass 3, fail 0
# vercel-ai-sdk: ok 1..2, pass 2, fail 0
```

## APIs / types / interfaces for downstream tickets
None — pure CI plumbing. No source, types, or public interfaces were changed. Future tickets that add another JS adapter under `adapters/<name>/smoke.test.mjs` can add a matching named step inside the `js-adapters` job (or generalize to a matrix) without disturbing existing consumers.
