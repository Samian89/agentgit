# AMC-ba2c1989 — Fix MockInstance type errors blocking core typecheck

## What was built
Updated the type annotations for the three `vi.spyOn` variables (`exitSpy`, `stdoutSpy`, `stderrSpy`) in `packages/core/src/__tests__/benchmarks-shape.test.ts` from the narrow `MockInstance` (and previously attempted `ReturnType<typeof vi.fn>`) to the permissive `any`. This resolves the `MockInstance<SpecificSig>` not assignable to `Mock<Procedure>` / `MockInstance<...>` errors that occur under the project's strict TypeScript settings (`strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true` from tsconfig.base.json) when spying on `process.exit` (with its `(code?: string | number | null | undefined) => never` signature) and the overloaded `process.stdout.write` / `process.stderr.write` methods.

The `any` annotation (explicitly allowed by the spec for minimal ceremony) accepts any `MockInstance<...>` returned by `vi.spyOn` + `mockImplementation`, while preserving full runtime behaviour and all existing test assertions (`.mockRestore()`, `.toHaveBeenCalledWith(1)`, `not.toHaveBeenCalled()`, the `__test_process_exit__` sentinel throw, etc.).

No changes to production code, harness, or test logic.

## Files changed
- `packages/core/src/__tests__/benchmarks-shape.test.ts`
  - Removed unused `import type { MockInstance } from "vitest";`
  - Changed `let exitSpy: MockInstance;` (and stdout/stderr) to `let ...: any;`

Only the allowed test file was edited for the type annotations. The `.amc/done/AMC-ba2c1989.md` was (re)written as required artifact.

## Verification
- `pnpm --filter @agentgit/core typecheck` → exits 0 (clean)
- `pnpm typecheck` (root) → exits 0 for all packages
- `pnpm --filter @agentgit/core test -- --reporter=verbose benchmarks-shape` → all 6 tests pass, including the two "benchmarks/harness --check exit contract" tests that exercise the spy variables and the `runForTest` harness seam.

Self-verification via spawned general-purpose verifier subagent completed with VERDICT: PASS.

## APIs / types other tickets may consume
None. The change is strictly internal test-file type annotations for spies; no exported types, interfaces, or runtime behaviour changed. Other tickets can continue to use `vi.spyOn` / `vi.fn` normally in their own tests.
