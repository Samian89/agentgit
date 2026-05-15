# Add Test Infrastructure for Web Viewer

## Goal
Establish a minimal but real test suite for `packages/web-viewer/` so that the browser-based bundle viewer has automated coverage of its core loading, parsing, and rendering paths, preventing regressions when bundle format or in-memory index logic changes.

## Context
`packages/web-viewer/` is a Vite + React application that provides a read-only drag-and-drop / `?bundle=<url>` viewer for `.agentgit-bundle` files. It depends on `@agentgit/ui-components` for the four shared components (StepCard, DiffView, BlameView, TimelineScrollbar) and on its own `src/bundle/` modules for tar + hash + unpack logic.

Currently the package has:
- No `test` script in `package.json`
- No `vitest.config.ts` or equivalent
- No `*.test.*` or `*.spec.*` files anywhere under `src/`
- A `vite.config.ts` that only configures the React plugin and build output

The web-viewer is built in CI (typecheck job line 36: `pnpm --filter @agentgit/web-viewer build`), but the build only runs `tsc --noEmit && vite build`. There are no runtime tests exercising `readBundle`, `InMemoryIndex`, or the App component's drag/drop and query-param loading flows.

In contrast, `packages/ui/` has a full vitest setup (`vitest.config.ts`, `src/__tests__/` with 5 test files, `scripts/seed-fixture.mjs`, and a `pretest` hook). The web-viewer shares the same component layer but has no equivalent test harness.

The in-memory index (`src/in-memory-index.ts`) and bundle unpack (`src/bundle/unpack.ts`) contain non-trivial logic that deserves protection.

## Technical Approach
1. Add Vitest + testing dependencies to `packages/web-viewer/package.json` devDependencies (matching the pattern in `packages/ui/package.json`): `@testing-library/react`, `@testing-library/user-event`, `happy-dom`, `vitest`, and `@vitejs/plugin-react` (already present for build).
2. Create `packages/web-viewer/vitest.config.ts` that configures the happy-dom environment and includes `src/**/*.test.{ts,tsx}` (or `**/*.test.*`).
3. Add a `test` script to `package.json`: `"test": "vitest run"`.
4. Create at least two focused test files:
   - `src/bundle/unpack.test.ts` (or `.test.mts`): unit tests for `readBundle` against a minimal valid bundle fixture (can be generated programmatically or checked in as a small .tar.gz). Assert manifest parsing, object extraction, and error paths for corrupt input.
   - `src/in-memory-index.test.ts`: tests for `InMemoryIndex` construction and the `getSessions` / `getCommits` / `getDiff` / `getBlame` methods using a synthetic `BundleContents` object. These are pure functions and easy to test without DOM.
5. Optionally add a lightweight component smoke test (`App.test.tsx`) that renders the idle drop-zone state and asserts the presence of the drop-zone testid. This can be added in a follow-up if the initial scope is kept minimal.
6. Update the root CI "unit" job (or add a web-viewer step) to run `pnpm --filter @agentgit/web-viewer test` after building dependencies. The viewer has no Rust/Tauri requirement, so it can be tested in the same job as core/sdk/cli.

The tests should be runnable in Node (happy-dom) without a real browser, matching the existing UI test setup.

## Acceptance Criteria
- [ ] `packages/web-viewer/package.json` has a `test` script and the necessary devDependencies.
- [ ] `packages/web-viewer/vitest.config.ts` exists and configures happy-dom.
- [ ] At least one test file exercises `readBundle` or `InMemoryIndex` and passes.
- [ ] `pnpm --filter @agentgit/web-viewer test` exits 0 locally.
- [ ] The CI unit job (or a new web-viewer-specific job) runs the web-viewer tests and they pass.
- [ ] Typecheck (`pnpm --filter @agentgit/web-viewer typecheck`) continues to pass.

## Files to Touch
- packages/web-viewer/package.json (modify | add test script + devDependencies for vitest + testing-library + happy-dom)
- packages/web-viewer/vitest.config.ts (create | vitest config with happy-dom environment)
- packages/web-viewer/src/bundle/unpack.test.ts (create | tests for readBundle)
- packages/web-viewer/src/in-memory-index.test.ts (create | tests for InMemoryIndex query methods)
- (optional) packages/web-viewer/src/App.test.tsx (create | minimal DOM smoke test for drop zone)

## Test Strategy
Local verification:

```bash
pnpm --filter @agentgit/web-viewer install   # if new deps
pnpm --filter @agentgit/web-viewer typecheck
pnpm --filter @agentgit/web-viewer test
```

CI will pick up the new tests once the package.json script and vitest config are present, because the existing "unit" job already does `pnpm install --frozen-lockfile` and `pnpm test` at the root (which runs vitest across the workspace). If the web-viewer is not automatically included, the unit job can be extended with an explicit `pnpm --filter @agentgit/web-viewer test` step (similar to how integration tests are filtered).

The new tests should be fast (< 5s total) and require no network or secrets.
