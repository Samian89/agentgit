---
layout: home
hero:
  name: AgentGit
  text: Local-first Git for AI agents
  tagline: Every prompt, every tool call, every state change — recorded as a tamper-evident, time-traversable commit log.
  actions:
    - theme: brand
      text: Get Started
      link: /quickstart
    - theme: alt
      text: Architecture
      link: /architecture
features:
  - title: Content-Addressed Object Store
    details: Every commit is SHA-256 hashed from its canonical JSON. Identical content always produces the same address — no duplicates, no corruption.
  - title: Full Session History
    details: Record prompts, tool calls, and state snapshots. Replay any session step by step. Branch from any point in history.
  - title: Drop-In Adapters
    details: One-line wrappers for TypeScript agents, Python agents, and LangChain. No framework changes required.
  - title: Safety Guards
    details: Block destructive tool calls with a confirmation prompt. Snapshot files before writes so every change is reversible.
  - title: Tauri Desktop UI
    details: Visual timeline, step cards with side-by-side diffs, and blame view — inspect any session without touching the terminal.
  - title: Portable Replay Export
    details: Export any session as a self-contained JSON file that can be replayed, diffed, or imported into other tools.
---

## Why AgentGit?

AI agents are increasingly taking consequential actions — editing files, calling APIs, modifying state — with no audit trail. When something goes wrong you must re-execute the entire session from scratch.

AgentGit gives every agent run a **tamper-evident, time-traversable commit log**, turning opaque agent sessions into inspectable, reproducible histories.

## Feature Matrix

| Feature | Status |
|---------|--------|
| `agentgit init` — initialize `.agentgit/` store | ✅ |
| `agentgit log` — list commits with hashes and summaries | ✅ |
| `agentgit diff <h1> <h2>` — step-level diff | ✅ |
| `agentgit branch` — named branches pointing to commits | ✅ |
| `agentgit checkout` — restore state snapshot | ✅ |
| `agentgit replay` — print tool calls in sequence | ✅ |
| `agentgit export` — emit replay JSON | ✅ |
| Content-addressed object store (SHA-256) | ✅ |
| SQLite metadata index | ✅ |
| TypeScript SDK (`wrapAgentJS`) | ✅ |
| Python drop-in adapter (`wrap_agent`) | ✅ |
| LangChain callback adapter | ✅ |
| ConfirmationGuard — blocks destructive tools | ✅ |
| SnapshotGuard — pre-write file snapshots | ✅ |
| Tauri desktop UI (timeline, diffs, blame) | ✅ |
| Replay JSON export schema | ✅ |
| Cloud sync / remote stores | ❌ out of scope |
| Multi-user collaboration | ❌ out of scope |

## Architecture

```
packages/core     — object store, SQLite index, commit graph
packages/cli      — commander-based CLI (agentgit)
packages/sdk      — TypeScript agent wrapper (wrapAgentJS)
adapters/python   — Python drop-in adapter
adapters/langchain— LangChain callback handler
packages/ui       — Tauri + React desktop app
```

## Core Docs

- [Quickstart](./quickstart.md) - install, wrap an agent, and inspect a log.
- [Architecture](./architecture.md) - object-store layout, SQLite ER diagram, sequence flow, and invariants.
- [Troubleshooting](./troubleshooting.md) - six operational failure modes with repros and fixes.
- [CLI reference](./cli-reference.md)
- [SDK API](./sdk-api.md)

All packages are MIT licensed.
