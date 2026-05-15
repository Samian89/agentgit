# Wire ShareSessionModal into the Tauri UI Toolbar

## Goal
Surface the already-implemented ShareSessionModal (remote push UI) so that the remote-sync write path that was added in the previous cycle is actually reachable from the desktop application, eliminating dead code and giving users a mouse-driven way to push a session after they have configured a remote in SettingsPanel.

## Context
`packages/ui/src/components/ShareSessionModal.tsx` exists, exports a controlled modal that calls the three new IPC commands `listRemotes`, `addRemote`, `pushSession`, and contains data-testid attributes for tests. The Rust side (`packages/ui/src-tauri/src/lib.rs`) already registers `list_remotes`, `add_remote`, `push_session`. `packages/ui/src/ipc.ts` already contains the typed wrappers. However, `packages/ui/src/App.tsx` never imports or renders `<ShareSessionModal ...>` — the toolbar only has New Session, Abandon, and Settings buttons. The subagent that read every component and the full App.tsx confirmed the modal is fully wired on the backend but has no trigger on the frontend. This is the only write-side modal from the "UI write features" list that is not yet reachable.

## Technical Approach
1. In `packages/ui/src/App.tsx` add a small piece of state: `const [shareModalOpen, setShareModalOpen] = useState(false);`
2. Add a toolbar button next to the existing "…" abandon button (or inside SettingsPanel) labelled "Share" that sets the flag true when a session is selected.
3. Render the modal at the bottom of the component tree exactly like the other three modals:
   ```tsx
   {shareModalOpen && selectedSession && (
     <ShareSessionModal
       dbPath={dbPath}
       sessionId={selectedSession}
       onClose={() => setShareModalOpen(false)}
     />
   )}
   ```
4. Pass a minimal `onPushed` callback that shows the existing toast (reuse `showToast`).
5. The modal itself already handles the "add remote first" flow and clipboard of the resulting URL; no changes required inside ShareSessionModal.tsx.
6. Add one line to the existing `BlameView.test.tsx` / `StepCard.test.tsx` pattern or a new lightweight render test if desired (the component already has data-testid, so a smoke render is cheap).

Follows the identical state + conditional-render + toast pattern already used for NewSessionModal and AbandonSessionModal in the same file.

## Acceptance Criteria
- [ ] When a session is selected, a "Share" button (or equivalent affordance) appears in the toolbar.
- [ ] Clicking it opens `ShareSessionModal` with the correct `sessionId` and `dbPath`.
- [ ] The modal can list remotes, add a new one, and invoke pushSession (the underlying IPC is already tested via Rust/TS boundary in the UI test fixtures).
- [ ] Closing the modal or successful push returns focus to the main timeline without crashing.
- [ ] `pnpm --filter @agentgit/ui test` continues to pass (existing fixture-db tests still green).

## Files to Touch
- packages/ui/src/App.tsx (modify | add 4–6 lines of state + button + conditional render for ShareSessionModal)
- packages/ui/src/components/ShareSessionModal.tsx (read-only | already complete, just needs a caller)
- packages/ui/src/ipc.ts (read-only | confirms pushSession etc. signatures)
- packages/ui/src-tauri/src/lib.rs (read-only | confirms the three remote IPC handlers exist)

## Test Strategy
Run the UI's own test command (identical to the one used in CI typecheck + release tauri matrix):

```bash
cd packages/ui
pnpm pretest   # seeds the fixture DB used by all UI tests
pnpm test      # vitest run; must still pass all existing + any new smoke render of ShareSessionModal
```

Because the modal is already covered by its own test file (`ShareSessionModal.test.tsx` exists per directory listing) and only needs a mount point, a single engineer can wire the trigger, verify the render, and land the change in one session. No Rust or IPC changes are required.