# Tauri UI — Write-Side Features

## Goal
Make the Tauri desktop app capable of an end-to-end record → browse → replay loop without dropping to the CLI: New Session, Replay-from-here, Export-as-bundle, Delete/abandon session, and a Settings panel for guards + `user.name`/`user.email`.

## Context
- The UI is currently read-only (`packages/ui/src-tauri/src/main.rs` exposes only `get_sessions`, `get_commits`, `get_diff`, `get_blame`).
- The React layer (`packages/ui/src/components/`) renders session/commit/diff/blame views from data fetched via `packages/ui/src/ipc.ts`.
- Spec 004 introduces the bundle format used by the "Export as .agentgit-bundle" action.
- Spec 002 introduces `.agentgit/config.json` with `user.*` and `signing.*`; spec 003 extends it with `guards.*` — the Settings panel writes to the same file.
- Replay semantics today: `agentgit replay` only prints the recorded tool calls. "Replay from here" in the UI means: create a *new session* whose first commit is a manual snapshot of the chosen commit's tree state, with a `metadata.replayedFrom` link back.

## Technical Approach
1. **New Tauri IPC commands (`main.rs`)**
   - `create_session(name: String, metadata: serde_json::Value) -> Session`
   - `replay_from_commit(commitHash: String, newSessionName: String) -> Session`
   - `export_bundle(sessionId: String, outPath: String) -> { bundlePath }`
   - `abandon_session(sessionId: String) -> ()`
   - `read_config() -> ConfigJson`
   - `write_config(config: ConfigJson) -> ()`
   - All call into a thin Rust binding that shells out to the SDK / CLI binary (acceptable v0.2 implementation) or links the core directly via NAPI (preferred long-term; out of scope for this spec — pick "shell out to `agentgit` binary" for simplicity).
2. **React UI**
   - "New session" button on the session list header → modal with name + free-form JSON metadata textarea → calls `create_session` → selects the new session.
   - Commit row right-click context menu with two items:
     - "Replay from here" → prompts for new session name → calls `replay_from_commit` → switches to the new session.
     - "Export as .agentgit-bundle" → opens save dialog → calls `export_bundle` → toast with path.
   - Session header gains a "..." menu: "Abandon session" (with confirmation modal that requires typing the session name to confirm).
   - New "Settings" route accessible from the top nav: form with `user.name`, `user.email`, `signing.enabled`, `signing.keyPath`, `guards.enabled`, `guards.confirmation.allowlist` / `denylist` / `autoConfirm`, `guards.snapshot.enabled`, `guards.snapshot.maxBlobBytes`. Loads on mount via `read_config`; saves via `write_config`.
3. **Right-click menu library**
   - Use `@radix-ui/react-context-menu` (already common in Tauri React apps; small bundle). Add to UI package deps.
4. **State management**
   - Existing UI is plain React state. Keep that; add a tiny store (Zustand or context) for session list + selected commit if prop-drilling becomes painful.
5. **Confirmation modal**
   - For destructive actions (abandon) require typing the session name; for replay just a single "Confirm" button.

## Acceptance Criteria
- [ ] "New session" button creates a session via IPC; it appears in the session list and is selected.
- [ ] Right-click a commit → "Replay from here" → enters a new-session-name prompt → new session is created with a single initial commit whose tree matches the source commit's tree.
- [ ] Right-click a commit → "Export as .agentgit-bundle" → save dialog → file is written and verifies via `agentgit bundle import` on a clean repo.
- [ ] Session header "..." → "Abandon" → confirmation modal → on confirm, session `status` becomes `abandoned` and disappears from the default session list (toggle to show abandoned).
- [ ] Settings panel loads current `.agentgit/config.json` values, edits persist on save, and a new wrapped agent picks up the new guard settings without restart of the UI.
- [ ] Existing read flows (commit timeline, diff, blame) still work after the refactor.

## Files to Touch
- packages/ui/src-tauri/src/main.rs  (modify — six new IPC commands)
- packages/ui/src-tauri/Cargo.toml  (modify if needed)
- packages/ui/src/ipc.ts  (modify — new IPC wrappers)
- packages/ui/src/App.tsx  (modify — wire new actions)
- packages/ui/src/components/NewSessionModal.tsx  (create)
- packages/ui/src/components/CommitContextMenu.tsx  (create)
- packages/ui/src/components/AbandonSessionModal.tsx  (create)
- packages/ui/src/components/SettingsPanel.tsx  (create)
- packages/ui/src/components/StepCard.tsx  (modify — context menu wiring)
- packages/ui/package.json  (modify — add @radix-ui/react-context-menu)

## Test Strategy
- Vitest + jsdom unit tests for each new modal (form validation, IPC mocking).
- Manual end-to-end run: `pnpm --filter @agentgit/ui tauri dev`, record an agent in another shell, switch to UI, perform New → Replay → Export → Abandon flow.
- Tauri build in CI (already in `release.yml`) must continue to succeed.
