# Documentation Overhaul (README, Architecture, Troubleshooting)

## Goal
Replace the one-line `README.md` with a complete project landing page, add a definitive `docs/architecture.md` that documents the data model and invariants, and add `docs/troubleshooting.md` covering common operational failure modes. After this work a new contributor can install, record an agent, and reason about the data model without reading source.

## Context
Current state:
- `README.md` contains only `# AgentGit` (11 bytes). Discoverability is zero.
- `docs/` already has `quickstart.md`, `cli-reference.md`, `sdk-api.md`, `adapters.md`, `replay-export.md`, `safety-guards.md`, `index.md` — but no architecture overview and no troubleshooting page.
- The data model (canonical-JSON hashing, sharded object store, SQLite mirror schema, FK invariants) is documented inline in `packages/core/src/types.ts` and `packages/core/src/schema.sql` but never collected into one architectural narrative.
- VitePress is already wired (`pnpm docs:dev` / `pnpm docs:build`).
- No `agentgit fsck` command yet — the troubleshooting recovery sections that reference it must either describe the manual recovery procedure today or be sequenced after spec 007.

## Technical Approach
1. **README.md rewrite**
   - Tagline ("Local-first Git for AI agents.") and 60-second pitch.
   - Install one-liner (placeholder `npm install -g @agentgit/cli` plus pnpm dev path).
   - 10-line "wrap your agent" code sample using `wrapAgentJS` from `@agentgit/sdk`.
   - Feature matrix: two columns (Built / Planned). Built = init/log/diff/branch/checkout/replay/export, Tauri read UI, Python + LangChain adapters, two default guards. Planned = the open tickets in this plan (remote sync, merge, gc, fsck, bundle, etc.).
   - Links: `docs/quickstart.md`, `docs/architecture.md`, `docs/troubleshooting.md`.
   - Badges: build (GitHub Actions), tests passing, license MIT. Use shields.io.
2. **docs/architecture.md**
   - ASCII/Mermaid diagram of the on-disk layout under `.agentgit/` (`objects/<2>/<62>`, `refs/`, `HEAD`, `index.db`).
   - Mermaid ER diagram of the SQLite schema (sessions, commits, blobs, tree_entries, refs) with FKs.
   - Sequence diagram: `wrapAgentJS(agent).run(prompt)` → guards → object writes → SQLite transaction → commit hash returned.
   - Canonical-JSON rules: sorted keys, hash field stripped before digest, encoding UTF-8, lowercase hex output.
   - Invariants: FK enforcement (`PRAGMA foreign_keys=ON`), WAL mode, idempotent DDL, parent links restricted, session FK cascades.
3. **docs/troubleshooting.md**
   - SQLite locking under concurrent writers (single-writer model, busy-timeout guidance).
   - Recovering from corrupted object store (today: manual hash recompute; cross-link to spec 007's `agentgit fsck`).
   - Symlink handling (links are dereferenced; recorded as blob content).
   - Large-blob handling (current threshold + future chunked-storage plan; cross-link to spec 007's `agentgit gc`).
   - Windows path-length issues (260-char limit; recommend short repo paths or `\\?\` prefixes).
   - `.agentgit/` size management (gc workflow placeholder).
   - Each section is a reproduction recipe + a fix.
4. **VitePress nav** — update `docs/index.md` / sidebar config to include the two new pages.

## Acceptance Criteria
- [ ] `README.md` contains tagline, pitch, install line, ≤15-line wrapAgentJS snippet, feature matrix, links to architecture + troubleshooting, and at least three shields.io badges.
- [ ] `docs/architecture.md` contains an object-store layout diagram, an SQLite ER diagram, a `wrapAgentJS → commit` sequence diagram, and explicit prose for canonical-JSON + hash-field-strip + WAL + FK invariants.
- [ ] `docs/troubleshooting.md` has the six sections listed above; each has a reproduction recipe and a fix.
- [ ] `pnpm docs:build` succeeds with the new pages.
- [ ] A new dev, following only `README.md`, can clone the repo, run an installed agent, and see a commit in `agentgit log` within 5 minutes (validated by a teammate walkthrough or recorded steps).

## Files to Touch
- README.md  (modify — full rewrite)
- docs/architecture.md  (create)
- docs/troubleshooting.md  (create)
- docs/index.md  (modify — link the new pages)
- docs/.vitepress/config.* if it exists  (modify — sidebar)

## Test Strategy
- `pnpm docs:build` must succeed (no broken links, no Mermaid parse errors).
- Manual: walk through README quickstart on a clean clone; record any friction.
- Spell/link check via VitePress build warnings.
