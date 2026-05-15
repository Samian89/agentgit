// bench-log-10k.js
// Measures `agentgit log` end-to-end time over a 10k-commit session.
// Budget: < 200ms.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Repository } from "@agentgit/core";

export const NAME = "log-10k";
export const BUDGET_MS = 200;

const COMMITS = Number(process.env.AGENTGIT_BENCH_LOG_COMMITS ?? "10000");

let setupDir = null;
let setupSessionId = null;

export async function setup() {
  setupDir = join(tmpdir(), `agentgit-bench-log-${process.pid}-${Date.now()}`);
  mkdirSync(setupDir, { recursive: true });
  const repo = Repository.init(setupDir);
  const session = repo.createSession("bench");
  setupSessionId = session.id;
  for (let i = 0; i < COMMITS; i++) {
    repo.commit({
      sessionId: session.id,
      message: `commit ${i}`,
      stateEntries: [],
    });
  }
  repo.index.close();
}

export async function run() {
  // Cold-open mirrors what `agentgit log` does: open the repo, list
  // sessions, then read all commits for the target session.
  const t0 = performance.now();
  const repo = Repository.open(setupDir);
  const sessions = repo.index.listSessions();
  const commits = repo.log(setupSessionId);
  repo.index.close();
  const elapsed = performance.now() - t0;
  if (sessions.length === 0 || commits.length !== COMMITS) {
    throw new Error(`unexpected results: sessions=${sessions.length} commits=${commits.length}`);
  }
  return elapsed;
}

export async function teardown() {
  if (setupDir !== null) {
    rmSync(setupDir, { recursive: true, force: true });
    setupDir = null;
  }
}
