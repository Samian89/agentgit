# `agentgit remote` — Push/Pull Sync with Reference Server

## Goal
Add remote sync so two machines can share a session: design and document a wire protocol (3a), implement `agentgit remote add/list/remove`, `push`, `fetch`, `pull` and a reference server under `packages/remote-server/` (3b), and add a "Share session" button to the Tauri UI (3c).

## Context
- Today repos are local-only. `Repository` writes everything under `.agentgit/`. There is no `refs/remotes/`, no remote tracking, no transport.
- Bundle format from spec 004 already gives a portable single-file dump — the remote protocol is essentially "streaming bundle subsets with negotiation."
- Auth from spec 002 (`user.name`/`user.email`/Ed25519 keys) provides commit-level identity; remote auth needs an additional token model.
- Tauri UI currently has only four read IPC commands; this work needs new write-side IPCs that shell out to the SDK push/pull APIs.

## Technical Approach
1. **Protocol design (`docs/remote-protocol.md`, the 3a deliverable)**
   - Choose **JSON-over-HTTPS** rather than git's smart-HTTP. Reasoning: simpler implementation, easier debugging, no pack-format work, fine for low-volume agent sessions. Document the bandwidth tradeoff (~10–30% larger than packfiles) explicitly.
   - Endpoints:
     - `POST /api/v1/refs/list` → `{ refs: [{ name, target }] }`
     - `POST /api/v1/objects/missing` — client sends `{ wants: [hash], haves: [hash] }`; server replies with `{ missing: [hash] }`.
     - `POST /api/v1/objects/upload` — chunked upload (1MiB chunks) with resumable `Upload-Id` semantics. Idempotent on hash collision.
     - `POST /api/v1/objects/download` — returns NDJSON of `{ hash, body }` for requested hashes.
     - `POST /api/v1/refs/update` — atomic ref CAS.
   - Auth: bearer token in `Authorization: Bearer <token>`. Tokens issued by server admin; stored client-side in `~/.agentgitconfig` under `remotes.<name>.token`.
   - Resumability: server stores partial upload state keyed by `Upload-Id`; client resumes by re-sending the same id.
2. **Client (`packages/core/src/remote/`)**
   - `RemoteClient` class with `listRefs`, `negotiateMissing`, `uploadObjects(stream)`, `downloadObjects(hashes)`, `updateRef`.
   - `Repository.push(remote, refs)` and `Repository.fetch(remote, refs)` orchestrate.
   - Network errors mid-push are recoverable: client persists the in-progress `Upload-Id` set in `.agentgit/remote-state.json` and retries from the last acknowledged offset on the next push.
3. **CLI**
   - `agentgit remote add <name> <url> [--token=...]` / `remote list` / `remote remove <name>`
   - `agentgit push <remote> <session-or-ref>`
   - `agentgit fetch <remote> [<ref>...]`
   - `agentgit pull <remote> <ref>` (fetch + fast-forward only — no merge until spec 006 lands)
4. **Reference server (`packages/remote-server/`)**
   - Fastify (zero-config TS, fast). Storage: filesystem under a `data/` dir mirroring `.agentgit/objects` layout, plus a tiny SQLite DB for ref state and pending uploads.
   - Single-binary `agentgit-remote-server` entrypoint with `--port`, `--data-dir`, `--token-file` flags.
   - Auth: HMAC-validated tokens loaded from `--token-file` (newline-delimited).
5. **UI integration**
   - New Tauri Rust IPC commands: `add_remote`, `list_remotes`, `push_session`.
   - "Share session" button on the session header → opens a small modal: pick remote → show progress → on success copy a shareable URL (`https://<remote>/sessions/<id>`) to the clipboard.
6. **Tests**
   - End-to-end: spin up the reference server in a test, push from a temp repo, fetch into a second temp repo, assert ref/object equivalence.
   - Failure injection: kill the server mid-upload, restart it, retry push, assert success and idempotency.

## Acceptance Criteria
- [ ] `docs/remote-protocol.md` exists and documents all five endpoints, the auth model, and the bandwidth-vs-packfile tradeoff.
- [ ] `agentgit remote add/list/remove` work and persist to `~/.agentgitconfig`.
- [ ] `agentgit push <remote> <session>` uploads only objects the server reports missing.
- [ ] `agentgit fetch <remote> <ref>` downloads objects + updates `refs/remotes/<remote>/<ref>`.
- [ ] `agentgit pull <remote> <ref>` is fast-forward-only; refuses non-FF until merge support lands.
- [ ] Two-machine round-trip: machine A pushes session S; machine B fetches; `agentgit log` on B matches A's.
- [ ] Mid-push network failure: kill server during upload; retry succeeds without re-uploading already-acknowledged chunks.
- [ ] Tauri UI "Share session" button: pick remote → push completes → success toast + shareable URL on clipboard.
- [ ] `agentgit-remote-server` boots with `--port 8787 --data-dir ./tmp --token-file ./tokens` and serves the five endpoints.

## Files to Touch
- docs/remote-protocol.md  (create)
- packages/core/src/remote/client.ts  (create)
- packages/core/src/remote/protocol.ts  (create — request/response types)
- packages/core/src/repository.ts  (modify — push/fetch methods)
- packages/cli/src/commands/remote.ts  (create)
- packages/cli/src/commands/push.ts  (create)
- packages/cli/src/commands/fetch.ts  (create)
- packages/cli/src/commands/pull.ts  (create)
- packages/cli/src/index.ts  (modify)
- packages/remote-server/  (create — Fastify app)
- packages/ui/src-tauri/src/main.rs  (modify — add remote IPCs)
- packages/ui/src/components/ShareSessionModal.tsx  (create)
- packages/core/src/__tests__/remote-roundtrip.test.ts  (create)

## Test Strategy
- Vitest end-to-end test boots the reference server on an ephemeral port, performs full push/fetch round-trip.
- Resumability test uses a custom transport that drops the connection after N bytes.
- CLI integration test wires through `agentgit push` against the in-process server.
