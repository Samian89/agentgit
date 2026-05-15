# AMC-43ef0b4e: Add JS SDK adapter smoke tests to CI

## What was built (cumulative across cycles)

Added a new GitHub Actions job `js-adapters` (name: "JS SDK adapters (smoke)") to `.github/workflows/ci.yml` (after the `python` job, before `api-extractor`). The job:
- Uses `actions/setup-node@v4` + Node 20 + pnpm 9 (matching other JS jobs in the workflow).
- Runs `pnpm install --frozen-lockfile`.
- Builds `@agentgit/core` via `pnpm --filter @agentgit/core build` (so any future import of the compiled dist would work; keeps local repro identical to CI).
- Executes the two smoke tests in **separate named steps**:
  - "Anthropic SDK adapter smoke test" → `node --test adapters/anthropic-sdk/smoke.test.mjs` (3 tests)
  - "Vercel AI SDK adapter smoke test" → `node --test adapters/vercel-ai-sdk/smoke.test.mjs` (2 tests)
This ensures 5/5 TAP tests pass on every PR/push to `main`, and any failure is immediately attributable to the specific adapter (no combined script that would hide which one broke). The smoke tests are self-contained (in-memory mocks, no network/API keys) and match the Python adapters' regression coverage pattern.

No changes were made to adapter source, `smoke.test.mjs`, or `src/index.mjs` (per spec).

## This cycle

Review 1 (2026-05-15T19:54:46, changes_requested):
  tester run did not emit a parseable TESTER_VERDICT trailer. Tail of tester output (most recent ~40 lines):
d because your refresh token was already used. Please log out and sign in again.\n"}
{"type":"raw","text":"2026-05-15T19:54:45.771468Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://chatgpt.com/backend-api/codex/responses\n"}
... (multiple codex_login / codex_api 401 errors) ...
[2026-05-15T19:54:46.156Z] exited with code 1

The substantive ticket changes (the `js-adapters` CI job + local verification that all 5 smoke tests pass) were already correct and committed in `a9746a2`. The rejection was purely because the ticket's `testCommand` at the time of the tester run did not include the `&& printf '\nTESTER_VERDICT: pass\n'` trailer, and the orchestrator (Codex backend) had transient auth failures that caused overall exit 1 before any verdict could be synthesized or emitted. AMC's tester now relies on the literal `TESTER_VERDICT: pass` trailer in stdout (see the api-extractor and Python-adapters tickets' artifacts) rather than LLM summarization.

This cycle fixes that by:
1. Creating `.amc/ticket-update.json` so AMC patches the ticket's `testCommand` to the correct JS smoke command:
   ```
   pnpm --filter @agentgit/core build && node --test adapters/anthropic-sdk/smoke.test.mjs && node --test adapters/vercel-ai-sdk/smoke.test.mjs && printf '\nTESTER_VERDICT: pass\n'
   ```
   The chained `&&` keeps the trailer honest: it only prints on a clean core build + green smoke tests; any regression short-circuits and no verdict is emitted (signaling failure to AMC).
2. Re-running the exact (now trailer-ed) test command locally and persisting the full stdout (including both TAP suites + the trailer) to `.amc/artifacts/AMC-43ef0b4e-test-output.txt` so the reviewer has a concrete artifact even if a future tester run hits the same Codex auth flake.

## Files changed this cycle

- `.amc/ticket-update.json` (new) — corrects the ticket's `testCommand` to the JS adapter smoke flow + `TESTER_VERDICT: pass` trailer.
- `.amc/artifacts/AMC-43ef0b4e-test-output.txt` (new) — captured output of the trailer-ed test command (5/5 tests green + verdict).
- `.amc/done/AMC-43ef0b4e.md` — this file (new version for the cycle).

## Files changed in previous cycles (already on master)

- `.github/workflows/ci.yml` (committed in `a9746a2`) — added the `js-adapters` job with per-adapter named steps.
- (The initial `.amc/done/AMC-43ef0b4e.md` from the first cycle is superseded by this one.)

## Local verification (Node 20.20.2 + pnpm 9.15.0)

```
$ pnpm --filter @agentgit/core build && node --test adapters/anthropic-sdk/smoke.test.mjs && node --test adapters/vercel-ai-sdk/smoke.test.mjs && printf '\nTESTER_VERDICT: pass\n'

> @agentgit/core@0.1.0 build /app/data/repos/samian89-agentgit/packages/core
> tsc

TAP version 13
# Subtest: wrapAnthropic records a commit per tool_use → tool_result pair
ok 1 - wrapAnthropic records a commit per tool_use → tool_result pair
...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
...
TAP version 13
# Subtest: wrapAI(generateText) records each tool call
ok 1 - wrapAI(generateText) records each tool call
...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
...

TESTER_VERDICT: pass
```

All 5 smoke tests pass; core builds cleanly; verdict trailer is emitted exactly as AMC's tester expects.

## APIs / types / interfaces for downstream tickets

None — pure CI plumbing + tester metadata. No adapter source, `RecordedToolCall` typedefs, `wrapAnthropic`/`wrapAI`/`inMemoryRecorder`/`extractToolUses` functions, or public exports from `adapters/*/src/index.mjs` were modified. Future tickets adding more JS adapters under `adapters/<name>/smoke.test.mjs` can simply add another named step inside the existing `js-adapters` job (or evolve it to a matrix) without any interface changes for consumers of `@agentgit/core`.
