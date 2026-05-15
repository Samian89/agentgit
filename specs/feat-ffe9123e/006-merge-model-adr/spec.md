# Merge / Multi-Branch Model — ADR + Implementation

## Goal
Decide and document what "merging two agent sessions" means in AgentGit, write an ADR, then implement the chosen option with explicit conflict/replay tests. Branches currently exist as refs but the per-session commit graph is a singly-linked list — there is no merge-base, no merge commit, and no defined behavior.

## Context
- `Repository.createBranch` (`packages/core/src/repository.ts`) sets a ref pointing to a commit. There is no notion of multiple parents on a `Commit` — its `parent: Hash | null` is singular.
- `CommitGraph.ancestors` already walks parent links with cycle detection — fine for current single-parent shape, must be extended if we introduce multi-parent merges.
- Three options on the table:
  - **(a) Cherry-pick replay** — apply one branch's tool calls in order onto another. Easiest to implement; no schema change; semantics are "rerun these steps."
  - **(b) Three-way tree merge** — Git-style with conflict markers on overlapping file paths. Requires defining a merge base; requires `Commit.parents: Hash[]`; conflict resolution is interactive.
  - **(c) Reject the concept** — remove `createBranch` from the public surface; document that AgentGit is forward-linear-only.
- Spec 002 changes the `Commit` canonical body (adds `author`); adding `parents: Hash[]` is another canonical change. Best to bundle both into the same migration where possible.

## Technical Approach
1. **ADR `docs/adr/001-merge-model.md`**
   - State the three options, the tradeoff matrix (complexity, user value, semantic clarity), and the recommended decision: **option (a) cherry-pick replay** for v0.2, with option (b) as future work. Reasoning: agent state is rarely a clean text-diff target; "rerun these steps" matches user intent ("take the calculator-tool branch and apply its steps onto the search-tool branch").
   - Document that `createBranch` *stays* in the surface, with branch heads as ordinary single-parent commits, plus a new `agentgit cherry-pick` command.
2. **Implementation (assuming option a is selected; if the ADR review favours another option, re-spec)**
   - `agentgit cherry-pick <source-ref> --onto <target-ref> [--session <new-name>]`
     - Walks the source ref's commit chain back to the divergence point with the target ref.
     - For each commit on the source side, replays its `toolCall` (if present) or its state-snapshot delta onto the target session, producing new commits with new hashes.
     - Tool-call replays are deterministic: the recorded `input` and `output` are reused; the recorded `output` is *not* re-executed (we are reconstructing history, not re-running the agent).
     - State-snapshot commits (no `toolCall`) are applied as a path-level overlay; conflicts (same path modified differently on both branches since the merge base) yield a clear error listing the conflicting paths.
   - `agentgit merge-base <ref-a> <ref-b>` — utility command that returns the most recent common ancestor.
3. **Conflict handling**
   - On path-level conflict, write the source-side blob to `.agentgit/CONFLICT/<path>` and abort the cherry-pick with non-zero exit; user resolves manually then runs `agentgit cherry-pick --continue` (drop-in stretch — keep simple "abort + reset to target head" as MVP if time-constrained).
4. **UI surface**
   - Out of scope for this spec (separate UI ticket in spec 008 may add a "Cherry-pick onto…" right-click).

## Acceptance Criteria
- [ ] `docs/adr/001-merge-model.md` exists, states the three options, picks one with explicit reasoning, and is referenced from `docs/architecture.md`.
- [ ] `agentgit merge-base <a> <b>` returns the correct LCA on a forked-graph fixture.
- [ ] `agentgit cherry-pick <source> --onto <target>` produces new commits whose tool calls match the source side's tool calls but whose hashes are fresh (new parents).
- [ ] A conflict scenario (same path modified on both branches after merge base) yields a non-zero exit and a clear error listing the path(s); no partial mutation is left in the target session.
- [ ] If the ADR concludes with option (c) "reject the concept" instead, `createBranch` and `branch` CLI command are removed and tests are updated accordingly.
- [ ] If the ADR concludes with option (b), the spec is revised and re-planned before implementation.
- [ ] `CommitGraph` continues to handle the resulting graph correctly under cycle-detection tests.

## Files to Touch
- docs/adr/001-merge-model.md  (create)
- docs/architecture.md  (modify — link the ADR)
- packages/core/src/cherry-pick.ts  (create)
- packages/core/src/commit-graph.ts  (modify — `mergeBase(a, b)` helper)
- packages/core/src/repository.ts  (modify — expose cherryPick + mergeBase)
- packages/cli/src/commands/cherry-pick.ts  (create)
- packages/cli/src/commands/merge-base.ts  (create)
- packages/cli/src/index.ts  (modify)
- packages/core/src/__tests__/cherry-pick.test.ts  (create)
- packages/core/src/__tests__/merge-base.test.ts  (create)

## Test Strategy
- `merge-base.test.ts`: build a forked graph, assert LCA correctness across multiple shapes (linear, fork, double-fork).
- `cherry-pick.test.ts`: happy path + conflict path + idempotent re-run (cherry-picking the same source twice is a no-op or produces deterministic new hashes).
- CLI integration test wires both commands end-to-end.
