# `.agentgit-bundle` Portable Format + Web Companion Viewer

## Goal
Define a single-file portable bundle that captures a session's objects, commits, refs, and a versioned manifest; ship `agentgit bundle create` / `agentgit bundle import` CLI commands; and build `packages/web-viewer/` — a read-only browser app that can open a bundle dropped onto the page (or fetched from a URL) and reuse the existing UI components.

## Context
- Today `agentgit export` writes ad-hoc JSON to stdout (see `packages/cli/src/commands/export.ts`); there is no portable, self-contained file format.
- The Tauri UI (`packages/ui/`) is local-only — it talks to a SQLite file via four Rust IPC commands. Sharing a session requires copying the entire `.agentgit/` directory.
- React components in `packages/ui/src/components/` (`StepCard`, `DiffView`, `BlameView`, `TimelineScrollbar`) are framework-agnostic and can render from any data source that satisfies the same types.
- Spec 002 introduces `schema_version`; bundles must record it for forward compatibility.

## Technical Approach
1. **Bundle format**
   - Container: gzipped tar (.tar.gz) with `.agentgit-bundle` extension.
   - Top-level entries:
     - `manifest.json` — `{ formatVersion: 1, schemaVersion: 2, sessionIds: [...], createdAt, generator: "agentgit/x.y.z" }`
     - `objects/<2>/<62>` — only the objects reachable from the chosen sessions (computed by walking `commit → parent → tree → blob` from each session head).
     - `commits.jsonl` — one Commit JSON per line (denormalized for fast read).
     - `refs.json` — `[{ name, target, type, updatedAt }, ...]`
     - `sessions.json` — full Session records for the included sessions.
2. **CLI: `agentgit bundle`**
   - `agentgit bundle create <session...> [-o file.agentgit-bundle]`
     - Default output: `<session-name>.agentgit-bundle` in cwd.
     - Walks reachability; copies the minimal object set; emits the tarball.
   - `agentgit bundle import <file>`
     - Verifies every hash (recomputes canonical-JSON SHA-256 for each object — refuses on mismatch).
     - Refuses on `manifest.schemaVersion > current` ("bundle from a newer client").
     - Writes objects to the current repo's `.agentgit/objects/`, inserts commits/sessions/refs into `index.db` in one transaction.
3. **`packages/web-viewer/`**
   - Vite + React + TypeScript, no Tauri dependency.
   - Reuse `packages/ui/src/components/*` by promoting them into a shared `packages/ui-components/` workspace OR by symlink/path-import. Prefer the former (cleaner) but accept the latter for time.
   - Bundle is parsed in the browser using `pako` (gzip) + a minimal tar reader (~5kB). No SQLite in the browser — instead build an in-memory adapter implementing the same interface as `SqliteIndex`.
   - URL modes:
     - Drag-drop a local `.agentgit-bundle` onto the page.
     - `?bundle=<url>` query param fetches a remote bundle.
4. **Manifest evolution**
   - `formatVersion` is for the bundle layout itself; `schemaVersion` is the SQLite schema version. Bumping `formatVersion` requires a documented migration path.

## Acceptance Criteria
- [ ] `agentgit bundle create <sessionId>` produces a `.agentgit-bundle` file.
- [ ] `agentgit bundle import <file>` on a clean repo restores all included objects/commits/refs/sessions; every blob hash verifies on import.
- [ ] Round-trip test: create bundle → import to fresh repo → `agentgit log` matches the original.
- [ ] A bundle whose `manifest.schemaVersion` exceeds the client's is refused with a clear error.
- [ ] A bundle whose objects fail hash verification is refused; nothing is written.
- [ ] `packages/web-viewer/` builds with `pnpm --filter @agentgit/web-viewer build`.
- [ ] Drag-dropping a generated `.agentgit-bundle` onto the dev server (`pnpm --filter @agentgit/web-viewer dev`) renders the session in the same step/diff/blame UI as the Tauri app.
- [ ] No native dependencies in the web viewer (pure browser bundle).

## Files to Touch
- packages/core/src/bundle/  (create — pack, unpack, manifest types)
- packages/cli/src/commands/bundle.ts  (create)
- packages/cli/src/index.ts  (modify)
- packages/ui-components/  (create — extract shared components)
- packages/ui/src/components/  (modify — re-export from ui-components)
- packages/web-viewer/  (create — Vite app)
- packages/web-viewer/src/in-memory-index.ts  (create — SqliteIndex-shaped read API over bundle data)
- pnpm-workspace.yaml  (modify if needed)

## Test Strategy
- `packages/core/src/bundle/__tests__/roundtrip.test.ts` — pack → unpack → assert all objects + refs identical.
- Tamper test — flip a byte in a packed bundle, confirm import refuses.
- Playwright or simple jsdom test for the web viewer drag-drop happy path (acceptable to start with a manual smoke test if Playwright cost is high).
- CLI integration test `pnpm --filter @agentgit/cli test:integration` adds `bundle create/import` to the matrix.
