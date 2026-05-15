# Remote Server & Web Viewer — First-Class CI Visibility

## Goal
Give the reference remote-server implementation and the bundle web viewer the same automated execution guarantees that core, cli, and sdk already enjoy, closing the last two packages that are built in CI but never tested there.

## Context
- `packages/remote-server/` ships `vitest.config.ts`, a full `tests/roundtrip.test.ts` exercising the five protocol endpoints against an in-process Fastify + `RemoteClient`, and a `package.json` `"test"` script. It is listed in `pnpm-workspace.yaml` but absent from `vitest.workspace.ts`.
- `packages/web-viewer/` has a complete Vite + React implementation (drag-drop + `?bundle=` URL loading, strict `readBundle` validation, `InMemoryIndex` that feeds the shared UI components) but zero test files — only `typecheck` and `build` (which already runs `tsc --noEmit`).
- Both packages are built in the "Typecheck" CI job (`pnpm --filter ... build`) and therefore appear green, yet their runtime contracts are never re-verified on every PR.

The subagent that read server.ts, roundtrip.test.ts, web-viewer App.tsx + in-memory-index.ts, and the root workspace file confirmed the exact missing wiring.

## Technical Approach
1. **vitest.workspace.ts** (root): add a fourth entry for remote-server exactly like the existing three:
   ```ts
   { test: { name: "remote-server", root: "./packages/remote-server", environment: "node" } }
   ```
   (web-viewer stays out for now — it has no tests; its build already typechecks it.)
2. **.github/workflows/ci.yml** "unit" job: after the existing `pnpm test`, the workspace change above makes remote-server tests run automatically. No extra step required.
3. For web-viewer: add a one-line verification in the "typecheck" job (or keep the existing `pnpm --filter @agentgit/web-viewer build` which already fails on tsc errors). Optionally add a future `vitest` skeleton if a smoke render test is later written; for this polish pass the build + typecheck is accepted as the contract.
4. No changes to remote-server or web-viewer source — they already follow the monorepo conventions (ESM, vitest or tsc-only).

## Acceptance Criteria
- [ ] After the workspace edit, `pnpm test` output contains a "remote-server" project section and all its roundtrip tests pass.
- [ ] The GitHub "Unit tests" job log shows remote-server tests executing (green).
- [ ] `pnpm --filter @agentgit/web-viewer build` (already part of the typecheck job) continues to run and would catch any future TypeScript breakage in the viewer.
- [ ] No increase in CI wall time >30 s on the ubuntu runner (remote-server tests are fast in-process).

## Files to Touch
- vitest.workspace.ts (modify | add remote-server workspace definition)
- .github/workflows/ci.yml (read-only | the "unit" job already runs `pnpm test`; the workspace change is sufficient)
- packages/remote-server/vitest.config.ts (read-only | proves it is a valid vitest root with its own setup)
- packages/web-viewer/package.json (read-only | confirms `"build": "tsc --noEmit && vite build"`)
- packages/remote-server/tests/roundtrip.test.ts (read-only | the tests that will now be discovered by root vitest)

## Test Strategy
The commands that must stay green after the change are exactly the audit commands plus the workspace-driven test:

```bash
pnpm test                    # now includes remote-server project
pnpm --filter @agentgit/remote-server test   # still works standalone
pnpm --filter @agentgit/web-viewer build     # typecheck + bundle
```

These are already invoked by the root `pnpm test`, the GitHub "Unit tests" job, and the "Typecheck" job. One engineer can edit the five-line workspace file, run the command locally, and verify the remote-server section appears in the vitest report. Web-viewer needs no further work for this stabilization pass.