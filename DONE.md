# AMC-974820e7 - Documentation overhaul

## 1. What I built

This cycle addressed the reviewer follow-ups on the documentation overhaul:

- Corrected the architecture docs so commit recording is described accurately:
  `Repository.commit()` advances SQLite `sessions.head`; explicit branches are
  the path that write file refs and SQLite `refs` rows.
- Clarified that `hash`, `signature`, and `publicKey` are stripped only as
  top-level derived fields before hashing. Nested metadata remains content.
- Replaced Mermaid-dependent architecture diagrams with plain ASCII diagrams
  that render in the current VitePress setup.
- Tightened troubleshooting recovery guidance so examples are runnable from the
  source checkout, start with backups or dry runs, and avoid pretending a
  missing/corrupt index can be rebuilt today.
- Reworked the `.agentgit/` size-management recipe so it explicitly deletes
  stale `tree_entries`, then orphaned `blobs` rows, then unreferenced object
  files after the SQLite transaction commits.

`pnpm docs:build` succeeds.

## 2. Files changed

- `docs/architecture.md`
- `docs/troubleshooting.md`
- `DONE.md`

The README and VitePress navigation were already present and passing the stated
acceptance criteria in this worktree, so this follow-up focused on the rejected
accuracy and safety issues.

## 3. APIs, types, or interfaces other tickets may consume

No public APIs, types, commands, or runtime interfaces changed. The updates are
documentation-only.
