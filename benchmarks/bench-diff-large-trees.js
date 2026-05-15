// bench-diff-large-trees.js
// Two commits with 50k tree entries (large tree); measure repo.diff between them (partial diff).
// Budget: < 500ms for 50k entries (tree load + small change set; allows CI variance). Spec requires 500ms.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Repository } from "@agentgit/core";

export const NAME = "diff-large-trees";
export const BUDGET_MS = 500;

const ENTRIES = Number(process.env.AGENTGIT_BENCH_DIFF_ENTRIES ?? "50000");

let setupDir = null;
let fromHash = null;
let toHash = null;

export async function setup() {
  setupDir = join(tmpdir(), `agentgit-bench-diff-${process.pid}-${Date.now()}`);
  mkdirSync(setupDir, { recursive: true });
  const repo = Repository.init(setupDir);
  const session = repo.createSession("bench");

  // First commit: ENTRIES files with content "v1".
  const first = repo.commit({
    sessionId: session.id,
    message: "v1",
    stateEntries: Array.from({ length: ENTRIES }, (_, i) => ({
      path: `f/${i}.txt`,
      content: "v1",
    })),
  });
  fromHash = first.hash;

  // Second commit: mostly unchanged (content "v1"), but 50 entries changed to "v2".
  // This exercises large-tree diff (50k entries loaded) while keeping result size
  // small and timing stable across machines (avoids 50k object allocations in worst case).
  const MODIFIED_COUNT = 50;
  const secondEntries = Array.from({ length: ENTRIES }, (_, i) => ({
    path: `f/${i}.txt`,
    content: i < MODIFIED_COUNT ? "v2" : "v1",
  }));
  const second = repo.commit({
    sessionId: session.id,
    message: "v2",
    stateEntries: secondEntries,
  });
  toHash = second.hash;

  repo.index.close();
}

export async function run() {
  const repo = Repository.open(setupDir);
  const t0 = performance.now();
  const result = repo.diff(fromHash, toHash);
  const elapsed = performance.now() - t0;
  repo.index.close();
  const MODIFIED_COUNT = 50;
  if (result.modified.length !== MODIFIED_COUNT) {
    throw new Error(`expected ${MODIFIED_COUNT} modified, got ${result.modified.length}`);
  }
  return elapsed;
}

export async function teardown() {
  if (setupDir !== null) {
    rmSync(setupDir, { recursive: true, force: true });
    setupDir = null;
  }
}
