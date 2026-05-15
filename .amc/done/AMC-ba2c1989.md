# AMC-ba2c1989 — Fix MockInstance type errors blocking core typecheck

## What was built
Relaxed the `vi.spyOn` return-type annotations on the three spies in
`packages/core/src/__tests__/benchmarks-shape.test.ts` (`exitSpy`,
`stdoutSpy`, `stderrSpy`). The previous annotation `ReturnType<typeof vi.spyOn>`
resolved to `MockInstance<(this: unknown, ...args: unknown[]) => unknown>` —
contravariant in its parameters, so it rejected `process.exit`'s
`(code?: string | number | null) => never` and `process.stdout.write`'s
overloaded signature under the workspace's strict TS settings
(`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).

The fix replaces those annotations with the parameter-less `MockInstance`
type imported from `vitest`, which defaults to
`MockInstance<(...args: any[]) => any>` (Vitest's `Procedure`) and accepts
any concrete spy signature.

## Files changed
- `packages/core/src/__tests__/benchmarks-shape.test.ts`
  - Added `import type { MockInstance } from "vitest";`
  - Changed three `let …: ReturnType<typeof vi.spyOn>` declarations to
    `let …: MockInstance`.

No production code, harness, or config changes.

## Verification
- `pnpm --filter @agentgit/core typecheck` → exits 0
- `pnpm typecheck` (root, recursive) → exits 0 for all 7 typechecked packages
- `pnpm --filter @agentgit/core test -- --reporter=verbose benchmarks-shape`
  → 6/6 tests pass (incl. both `--check` exit-contract tests that exercise
  the spies)

## APIs / types other tickets may consume
None. The change is confined to internal test-file type annotations; no
exported types, interfaces, or runtime behaviour changed.
