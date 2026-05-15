# Fix MockInstance Type Errors in benchmarks-shape.test.ts

## Goal
Eliminate TypeScript compilation errors in `packages/core/src/__tests__/benchmarks-shape.test.ts` so that `pnpm --filter @agentgit/core typecheck` (and the root `pnpm typecheck`) exits 0, restoring the typecheck gate for the core package.

## Context
The root `pnpm typecheck` runs `pnpm -r typecheck` across all workspace packages. The `@agentgit/core` package's `typecheck` script is `tsc --noEmit` using the package's `tsconfig.json` (which extends `../../../tsconfig.base.json`). The base config enables `strict: true`, `exactOptionalPropertyTypes: true`, and `noUncheckedIndexedAccess: true`.

The file `packages/core/src/__tests__/benchmarks-shape.test.ts` uses `vi.spyOn(process, "exit")` and `vi.spyOn(process.stdout, "write")` / `vi.spyOn(process.stderr, "write")` to stub I/O for harness contract tests. The return type of `vi.spyOn` is `MockInstance<...>` whose generic parameter is inferred from the target's method signature. Under Vitest + TypeScript 5.x with the project's strict settings, the inferred signatures for `process.exit(code?: string | number | null | undefined): never` and the overloads of `fs.writeFileSync` (with `BufferEncoding` and callback variants) are not assignable to the looser `MockInstance<(this: unknown, ...args: unknown[]) => unknown>` that the test file's `exitSpy` / `stdoutSpy` / `stderrSpy` variables are typed as.

The errors are:
- Line 72: `MockInstance<(code?: string | number | null | undefined) => never>` is not assignable to `MockInstance<(this: unknown, ...args: unknown[]) => unknown>`
- Lines 77, 80: similar errors for the two `writeFileSync` overloads on `process.stdout` / `process.stderr`

The test itself is valuable: it verifies that `runForTest(["--check"], [violating])` causes `process.exit(1)` via the `runForTest` injection seam exported from `benchmarks/harness.js`. The test file imports the harness as a JS module (with `@ts-expect-error` for the lack of types) and exercises the `--check` budget-violation path.

## Technical Approach
1. In `packages/core/src/__tests__/benchmarks-shape.test.ts`, change the type annotations for `exitSpy`, `stdoutSpy`, and `stderrSpy` from the overly-specific `ReturnType<typeof vi.spyOn>` to the broader Vitest mock instance type that accommodates any function signature: `ReturnType<typeof vi.fn>` or `vi.MockInstance<(...args: unknown[]) => unknown>` (or simply `any` for the spy variables if the project prefers minimal ceremony).

2. Alternatively, cast the `mockImplementation` result to `never` or use `as unknown as MockInstance<...>` at the assignment sites to satisfy the strict checker while preserving the runtime behaviour.

3. The minimal, idiomatic Vitest fix is to declare the variables without a return-type annotation and let inference work from the first assignment, or to use `vi.spyOn(...) as any` for the three spy declarations. The test logic (`.mockRestore()`, `.toHaveBeenCalledWith(1)`, etc.) continues to work.

4. After the type fix, `pnpm --filter @agentgit/core typecheck` must exit 0, and `pnpm test` (which runs this test file) must still pass.

No production code or harness.js changes are required.

## Acceptance Criteria
- [ ] `pnpm --filter @agentgit/core typecheck` exits 0 with no errors from benchmarks-shape.test.ts (or any other file).
- [ ] `pnpm typecheck` (root) exits 0.
- [ ] `pnpm --filter @agentgit/core test` continues to pass, including the two "benchmarks/harness --check exit contract" tests that exercise the spy variables.
- [ ] The fix is isolated to the test file's type annotations; no behaviour change.

## Files to Touch
- packages/core/src/__tests__/benchmarks-shape.test.ts (modify | relax MockInstance type annotations for exitSpy/stdoutSpy/stderrSpy)

## Test Strategy
```bash
pnpm --filter @agentgit/core typecheck
pnpm --filter @agentgit/core test -- --reporter=verbose benchmarks-shape
```

Both must exit 0. The CI "Typecheck" job will then pass the core package without the previous recursive failure.
