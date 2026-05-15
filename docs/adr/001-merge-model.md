# ADR 001 — Merge / Multi-Branch Model

- **Status:** Accepted for v0.2
- **Date:** 2026-05-14
- **Deciders:** AgentGit core maintainers
- **Supersedes:** none
- **Spec:** `specs/feat-ffe9123e/006-merge-model-adr/spec.md`

## Context

`Repository.createBranch` already exists in `packages/core/src/repository.ts`:
it writes a ref under `refs/sessions/<name>` pointing at a commit hash and
upserts a matching `refs` row. Nothing else in the codebase exercises the
notion of multiple branches:

- `Commit.parent` is `Hash | null` — singly linked.
- `CommitGraph.ancestors` walks a single parent chain with cycle detection.
- There is no merge-base computation, no merge commit, no defined behaviour
  for "what does it mean to combine two branches?".

The `branch` CLI command therefore advertises capability the rest of the
system cannot deliver. We have to either define the missing semantics or
remove the surface.

We considered three options.

## Options

### (a) Cherry-pick replay — *chosen for v0.2*

Treat "merge" as **replay one branch's recorded tool calls onto another**.
For each commit on the source side from the merge base forward, materialise
a new commit on top of the target ref. The new commit reuses the source's
`toolCall` payload verbatim (recorded `input` and `output` are reapplied —
the agent is **not** re-run) and applies the recorded state-tree as a
path-level overlay. Conflicting paths abort the operation.

- Schema-compatible: `Commit.parent` stays singular; no new canonical body
  field, so the migration table in spec 002 keeps its narrow scope.
- Matches user intent for agent sessions: agents produce *narratives of
  steps*, not text-diffable artefacts, so "take these recorded steps and
  rerun them on top of that branch" reads as a natural mental model.
- Easy to test deterministically — replay is a pure function of recorded
  inputs and outputs.
- Doesn't add a "merge commit" UI concept that has no counterpart in agent
  workflows yet.

### (b) Three-way tree merge

Git-style merge with a computed merge base, multi-parent commits, and
conflict markers on overlapping file paths.

- Requires changing `Commit.parent: Hash | null` to `Commit.parents: Hash[]`,
  which is a canonical-body change — every existing object hash would shift
  unless gated by a migration that re-hashes commits.
- `CommitGraph.ancestors` and every cycle-detection / topology traversal
  must be rewritten to multi-parent shape.
- Conflict resolution is fundamentally interactive (or requires a resolver
  surface — UI, CLI prompt, or callback API) which is out of scope here.
- The semantic payoff is unclear for agent state: a `tools/calculator.py`
  blob doesn't have line-level meaning the way a source file does.

### (c) Reject the concept

Remove `createBranch` from the public surface; document AgentGit as
forward-linear-only and have users fork via `bundle create` + `bundle import`
into a fresh session.

- Smallest implementation footprint; no new commands.
- Removes capability we've already shipped — existing scripts that call
  `agentgit branch` would break.
- Branches at refs are still useful even without merging (named pointers
  for navigation, exports, and UI labels), so removing them loses value
  outside the merge question itself.

## Decision

Adopt **option (a) — cherry-pick replay** for v0.2.

`createBranch` and the `agentgit branch` CLI command stay. Branch heads
remain ordinary single-parent commits. A new pair of operations defines
multi-branch semantics:

- `agentgit merge-base <ref-a> <ref-b>` — return the most recent common
  ancestor.
- `agentgit cherry-pick <source-ref> --onto <target-ref> [--session <name>]`
  — replay the commits from the merge base to `<source-ref>` on top of
  `<target-ref>`, producing fresh commit hashes with new parents. A
  path-level conflict aborts the operation, leaves the target session head
  unchanged, and emits a non-zero exit code with the conflicting paths.

Option (b) is documented here as a future-work candidate but is **not**
scheduled. Re-opening the question requires a new ADR that supersedes this
one, the schema migration for multi-parent commits, and an explicit
resolver UX design.

## Consequences

### What this enables

- `Repository.cherryPick(source, target, opts)` and
  `CommitGraph.mergeBase(a, b)` are first-class core APIs that the CLI,
  SDK, and (later) the UI consume.
- Conflict behaviour is explicit: when source and target both modified the
  same path after the merge base, the operation exits non-zero with the
  conflicting paths and leaves the target session head unchanged. No
  partial mutation is committed and no half-applied state remains in the
  index.
- Tool-call replay is deterministic. The recorded `input` and `output`
  are reused as-is; the agent does **not** re-execute the tool, so replay
  is reproducible and safe to run offline.

### What this defers

- Multi-parent commits, real three-way merges, and interactive conflict
  resolution. If we adopt them, ADR 002 will supersede this one and the
  canonical `Commit` body will change in lockstep with a new migration.
- `agentgit cherry-pick --continue` after manual conflict resolution. The
  MVP is "abort cleanly and leave the target untouched"; a continue flow
  can be layered on without breaking the existing surface.

### What this constrains

- Tool-call replays do not re-execute side effects. Cherry-picking a
  branch that writes files outside `.agentgit/` will not re-create those
  external mutations — only the recorded state-tree overlay is applied.
  Users who need re-execution should `agentgit replay` instead.
- Because parents stay singular, the cherry-pick result records the
  *target* head as its parent, not both source and target. The link back
  to the source branch lives in `commit.metadata.cherryPickedFrom`.

## Verification

Acceptance is covered by the spec's test plan:

- `packages/core/src/__tests__/merge-base.test.ts` exercises LCA correctness
  on linear, fork, and double-fork graphs.
- `packages/core/src/__tests__/cherry-pick.test.ts` covers the happy
  replay path, the conflict-abort path, and idempotent re-run shape.
- `packages/cli/tests/integration/merge-base-cherry-pick.test.ts` wires
  both CLI commands end-to-end against a real `.agentgit/` directory.
