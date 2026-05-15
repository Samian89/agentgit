# CLI Remote Commands Test Coverage (push / fetch / pull)

## Goal
Bring the three network-oriented CLI commands (`agentgit push`, `fetch`, `pull`) under automated test coverage so that changes to the remote protocol client, token handling, or resumable upload logic cannot silently break the CLI surface that users invoke after `agentgit remote add`.

## Context
`packages/cli/src/index.ts` registers `pushCommand`, `fetchCommand`, and `pullCommand` (imported from `./commands/push.ts`, `fetch.ts`, `pull.ts`). Each delegates to core helpers `pushSession`, `fetchRefs`, `pullRef` (from `@agentgit/core` remote/sync). The integration test directory already contains `remote.test.ts` (covers `remote add/list/remove` and token persistence) and `remote-server` roundtrip tests exist in `packages/remote-server/tests/`. However, grep across `packages/cli/src/__tests__/` and `tests/integration/` for the three command function names returns zero hits. The subagent that exhaustively read every test file and the CLI command sources confirmed the gap. These commands are the only ones among the 19 that exercise the remote protocol end-to-end from the user's `agentgit` binary.

## Technical Approach
1. Extend the existing `packages/cli/tests/integration/remote.test.ts` (or add a sibling `remote-sync.test.ts` following the same mkdtemp + `initCommand` + `Repository` pattern).
2. Start an in-process `buildServer` from `@agentgit/remote-server` (exactly as `packages/remote-server/tests/roundtrip.test.ts` already does) on a random port with a throw-away token file.
3. Use the core `RemoteClient` (or the thin `getRemote` helper already present in cli remote.ts) to configure a local remote pointing at `http://127.0.0.1:port`.
4. Exercise the three CLI command functions directly:
   - `pushCommand(agentgitDir, "origin", "main", { token })` — verify objects appear on server, ref updated.
   - `fetchCommand(...)` — verify refs/remotes/origin/... written locally.
   - `pullCommand(...)` — verify fast-forward and session head advanced.
5. Assert on both CLI-side effects (exit code 0, config written) and server-side storage (via the test server's `__storage` or direct SQLite on its refs.db).
6. Add negative cases (token mismatch → 401, ref conflict → 409) using the same server harness.
7. The test file re-uses the CapturingReporter / tmpdir fixtures already present in the integration suite; no new core APIs required.

This follows the exact integration-test shape used by `merge-base-cherry-pick.test.ts` and `remote.test.ts`.

## Acceptance Criteria
- [ ] `pnpm --filter @agentgit/cli test:integration` executes at least one new test that calls `pushCommand`, `fetchCommand`, and `pullCommand` against a live local remote-server instance and passes.
- [ ] Coverage report (or manual grep) shows the three command modules under `packages/cli/src/commands/{push,fetch,pull}.ts` now have ≥1 hit from a test file.
- [ ] Token override via `--token` flag and persisted `remotes.<name>.token` are both exercised.
- [ ] The new test cleans up the ephemeral remote-server (no port leaks, no temp dirs left behind).

## Files to Touch
- packages/cli/tests/integration/remote.test.ts (modify | append push/fetch/pull cases, or create remote-sync.test.ts if separation preferred)
- packages/cli/src/commands/push.ts (read-only | to confirm the exported pushCommand signature)
- packages/cli/src/commands/fetch.ts (read-only)
- packages/cli/src/commands/pull.ts (read-only)
- packages/remote-server/tests/roundtrip.test.ts (read-only | copy the in-process server start pattern)
- packages/remote-server/src/server.ts (read-only | confirms buildServer + __storage export for test assertions)

## Test Strategy
The single command that must go green:

```bash
pnpm --filter @agentgit/cli test:integration -- --run remote
# or the full
pnpm test:integration
```

This is the same script already wired in root `package.json` and the GitHub "Integration tests" job. After the spec lands, re-running the audit command list will show the three previously untested command modules now touched by tests. The work is self-contained inside the CLI integration suite and can be completed by one engineer in a focused session.