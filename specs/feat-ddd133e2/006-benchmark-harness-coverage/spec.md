# Benchmark Harness — Automated Verification of --check Non-Zero Exit

## Goal
Add an automated test that the `benchmarks/harness.js --check` path exits with code 1 when any scenario exceeds its `BUDGET_MS`, so that the budget-enforcement contract (the only thing the "bench" CI job relies on) cannot regress without a failing test.

## Context
`benchmarks/harness.js` correctly implements the check:

```js
if (checkBudgets) {
  const failed = results.filter(r => !r.passed);
  if (failed.length > 0) process.exit(1);
}
```

However, `packages/core/src/__tests__/benchmarks-shape.test.ts` only imports `{ SCENARIOS, HERE, REPORT_SCHEMA }` and asserts on names and declared budgets; it never invokes `main()` or the `--check` branch. The subagent that read the entire harness and the shape test confirmed the execution path that produces the exit code used by CI is untested. A simulated violation (e.g., by temporarily patching a scenario's `BUDGET_MS` or by spying on `process.exit`) is the minimal way to close the gap without making the real benchmarks slow or flaky.

## Technical Approach
1. In `packages/core/src/__tests__/benchmarks-shape.test.ts` (or a sibling `benchmarks-exit.test.ts` co-located with the harness), import the harness module.
2. Use vitest's `vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });` (or `vi.fn()` + `expect(process.exit).toHaveBeenCalledWith(1)`).
3. Temporarily monkey-patch one scenario's `BUDGET_MS` to a value lower than its measured `run()` result (the scenarios already export the objects; the harness re-exports `SCENARIOS`).
4. Call the internal `main()` logic (or export a small `runWithArgs` helper from harness.js for testability) with `["--check"]`.
5. Assert that `process.exit(1)` was reached and that the report still contains `passed: false` for the violated scenario.
6. Restore the original budget after the test (or use a fresh copy of the scenario array).

If editing the harness to export a testable `runForTest(argv)` is cleaner, do so — the change is a few lines and keeps the CLI entry point unchanged.

## Acceptance Criteria
- [ ] `pnpm --filter @agentgit/core test -- benchmarks` (or the full `pnpm test`) executes a test that forces a budget violation and asserts `process.exit(1)`.
- [ ] The test passes on both happy path (no violation → exit 0) and violation path (exit 1).
- [ ] No real benchmark scenario is slowed down; the violation is injected.
- [ ] The shape-test file (or new sibling) remains the single source of truth for harness contract verification.

## Files to Touch
- packages/core/src/__tests__/benchmarks-shape.test.ts (modify | add violation-exit test or import from new file)
- benchmarks/harness.js (modify | optional: export `runForTest(argv)` or `SCENARIOS` mutator for test injection; keep CLI entry point identical)
- benchmarks/bench-log-10k.js (read-only | example of a scenario module that exports NAME + BUDGET_MS + run)
- packages/core/package.json (read-only | confirms the test script that will exercise the new case)

## Test Strategy
The command that must stay green (already wired in the core package and root CI):

```bash
pnpm --filter @agentgit/core test -- src/__tests__/benchmarks-shape.test.ts
# or simply
pnpm test
```

After the spec, the "bench" GitHub job (`pnpm bench --check`) will be protected by a unit test that would have caught a regression in the exit logic. One engineer can implement the spy + monkey-patch in a single session; the harness change (if any) is tiny and fully backward-compatible.