# AMC-974820e7 - Documentation overhaul

## 1. What I built

- Replaced the README with a full project landing page: tagline, pitch,
  install commands, a short `wrapAgentJS` example, feature matrix, docs links,
  and shields.io badges.
- Added/updated architecture documentation for the `.agentgit/` object-store
  layout, SQLite ER model, `wrapAgentJS` recording sequence, canonical JSON,
  hash-field stripping, WAL behavior, FK enforcement, idempotent migrations,
  and maintenance invariants.
- Reworked troubleshooting guidance for six failure modes: SQLite locking,
  corrupted object/index recovery, symlink handling, large blobs, Windows path
  length, and `.agentgit/` size management.
- Addressed reviewer feedback by removing Mermaid-only diagrams, correcting
  the ER/recovery guidance, and replacing the size-management recipe with a
  leaf-first cleanup flow that sweeps stale `tree_entries` and deleted-session
  blobs.
- Wired the new pages into VitePress navigation/sidebar and the docs home page.

## 2. Files changed

- `README.md`
- `docs/architecture.md`
- `docs/troubleshooting.md`
- `docs/index.md`
- `docs/.vitepress/config.mts`
- `DONE.md`

## 3. APIs, types, or interfaces other tickets may consume

No runtime APIs, types, commands, or interfaces were added or changed. This
cycle is documentation-only.
