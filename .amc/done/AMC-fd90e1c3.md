# AMC-fd90e1c3 — UI TypeScript strict fixes

## What was built
Eliminated two `pnpm --filter @agentgit/ui typecheck` errors caused by
`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`:

1. **App.tsx `refreshSessions` (firstActive guard).** The expression
   `rows.find(...) ?? rows[0]` still narrows to `T | undefined` under
   `noUncheckedIndexedAccess`, even after `rows.length > 0`. Replaced the
   length-gate with an explicit `if (firstActive)` so the `.id` access is
   provably safe. Acceptance criterion: prefers non-abandoned sessions, falls
   back to the first row, and is a no-op when every row is abandoned and there
   is nothing to pick (still no throw). `selectedSession` remains
   `string | null` throughout.

2. **StepCard.tsx → CommitContextMenu handler props.** The destructured
   `onReplay` / `onExportBundle` are typed `((c: CommitRow) => void) | undefined`,
   which violates `exactOptionalPropertyTypes` when passed to
   `CommitContextMenuProps` (declared as optional, *not* `| undefined`).
   Switched to presence-only spread:
   `{...(onReplay ? { onReplay } : {})}` — the key is omitted entirely when the
   handler is absent. Runtime behaviour is identical (already gated by the
   `if (onReplay || onExportBundle)` branch and by the `Boolean(...)` guard
   inside `CommitContextMenu`).

`CommitContextMenu.tsx` was left as-is — the StepCard fix removes the
violation at the call site, and tightening the menu's prop types would only
shift the same constraint to every future caller.

## Files changed
- `packages/ui/src/App.tsx` — guarded `firstActive` before reading `.id`; dropped the now-redundant `rows.length > 0` gate.
- `packages/ui/src/components/StepCard.tsx` — presence-only spread for `onReplay` / `onExportBundle`.

## Verification
- `pnpm --filter @agentgit/ui typecheck` — exits 0, no errors.
- `pnpm --filter @agentgit/ui vitest run` — 21/21 tests pass (5 StepCard, plus
  BlameView / DiffView / TimelineScrollbar / fixture-db). Verified with the
  vitest default `NODE_ENV=test`.
  - Note: when the parent shell exports `NODE_ENV=production`, every
    `@testing-library/react` test fails with "act(...) is not supported in
    production builds of React." This reproduces on `master` without my
    changes, so it is an environmental quirk in this harness session, not a
    regression. Vitest sets `NODE_ENV=test` by default in normal CLI use.

## APIs / types other tickets may consume
- No public API or type surface changed. `StepCardProps`, `CommitContextMenuProps`,
  and `refreshSessions` retain their existing signatures. Internal refactor only.
