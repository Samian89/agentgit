# AMC-075df0f0 — Add harness --check exit(1) verification test

## What was built
Closed the regression-coverage gap on the only code path that makes the
`bench` CI job fail. Previously `benchmarks-shape.test.ts` only checked
exported names/budgets and never invoked `main()` or the `--check` branch
that calls `process.exit(1)`.

Added an explicit test-injection seam to `benchmarks/harness.js` and three
new vitest cases in `packages/core/src/__tests__/benchmarks-shape.test.ts`:

1. `runForTest(["--check"], [violatingScenario])` → `process.exit(1)`
   (asserted via a `vi.spyOn(process, "exit")` mock that throws so the
   harness unwinds without killing the vitest worker).
2. `runForTest(["--check"], [passingScenario])` → resolves with the report
   and `process.exit` is **not** called (happy path == exit 0).
3. `runForTest([], [violatingScenario])` → returned report has
   `passed: false` for the violated scenario, confirming the in-report
   decision matches the exit contract.

Fake scenarios are tiny in-memory `{ NAME, BUDGET_MS, setup, run, teardown }`
objects whose `run()` returns a constant elapsed-ms value, so the test is
deterministic and never invokes the real (slow) benchmark fixtures. The
real scenarios are not slowed down or modified.

Test command stays the same and still resolves to the same file:
`pnpm --filter @agentgit/core test -- src/__tests__/benchmarks-shape.test.ts`.
6 tests pass in ~0.5s; the full core suite (224 tests) is green.

## Files changed
- `benchmarks/harness.js` — refactored the inlined main() into an exported
  `runForTest(argv = [], scenariosOverride = null)` helper that returns the
  report object. The CLI entry point still works identically (it now calls
  `runForTest(process.argv.slice(2))`). The previous module-load-time argv
  parsing was moved inside the function so each test invocation gets fresh
  state. `runScenario` now takes `iterations` as a parameter (also moved
  inside `runForTest`).
- `packages/core/src/__tests__/benchmarks-shape.test.ts` — added a new
  `describe("benchmarks/harness --check exit contract")` block with the
  three cases above plus `beforeEach`/`afterEach` that spy on `process.exit`,
  `process.stdout.write`, and `process.stderr.write` (the last two silence
  the harness's report JSON / progress lines so test output stays clean).

## APIs / types other tickets may consume
- `runForTest(argv: string[], scenariosOverride?: Scenario[] | null): Promise<Report>`
  is now exported from `benchmarks/harness.js`. Scenario shape is unchanged:
  `{ NAME: string; BUDGET_MS: number; setup(); run(): Promise<number>; teardown() }`.
  Report shape is unchanged (`{ schema, generatedAt, iterations, results: [...] }`).
  Any other ticket that wants to script the harness from JS/TS (e.g. a
  perf-regression dashboard) can import `runForTest` instead of shelling out
  to `node ./harness.js`.
- `SCENARIOS`, `REPORT_SCHEMA`, `HERE`, and `reportPathFor(name)` exports
  are preserved exactly as before — no consumer changes.
- The CLI contract (`node ./harness.js [--check] [--report <path>]`) is
  unchanged; `--check` still exits with code 1 on budget violation and 0
  otherwise, and an uncaught error in the run still exits with code 2.
