// bench-ui-session-load.js
// Stand-in for the Tauri UI cold session-list + commits IPC time. We exercise
// the SAME SQLite index the UI's IPC handlers query (sessions + commits ORDER
// BY timestamp ASC) from a fresh process-side connection, which is the bulk
// of the cold-load cost. Budget: < 1000ms.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Repository, SqliteIndex } from "@agentgit/core";

export const NAME = "ui-session-load";
export const BUDGET_MS = 1000;

const SESSIONS = Number(process.env.AGENTGIT_BENCH_UI_SESSIONS ?? "10");
const COMMITS_PER_SESSION = Number(
  process.env.AGENTGIT_BENCH_UI_COMMITS_PER_SESSION ?? "500",
);

let setupDir = null;
let dbPath = null;
let sessionIds = [];

export async function setup() {
  setupDir = join(tmpdir(), `agentgit-bench-ui-${process.pid}-${Date.now()}`);
  mkdirSync(setupDir, { recursive: true });
  const repo = Repository.init(setupDir);
  for (let s = 0; s < SESSIONS; s++) {
    const session = repo.createSession(`bench-${s}`);
    sessionIds.push(session.id);
    for (let i = 0; i < COMMITS_PER_SESSION; i++) {
      repo.commit({
        sessionId: session.id,
        message: `c-${s}-${i}`,
        stateEntries: [
          { path: `f${i % 10}.txt`, content: String(i) },
        ],
      });
    }
  }
  dbPath = join(setupDir, "index.db");
  repo.index.close();
}

export async function run() {
  const t0 = performance.now();
  // Cold connection — equivalent to the UI opening sqlx::SqlitePool::connect.
  const index = new SqliteIndex(dbPath);
  const sessions = index.listSessions();
  // Mirror the UI: after the first commits IPC fires for the active session.
  const first = sessions[0];
  const commits = first ? index.getCommitsBySession(first.id) : [];
  index.close();
  const elapsed = performance.now() - t0;
  if (sessions.length !== SESSIONS) {
    throw new Error(`unexpected sessions: ${sessions.length}`);
  }
  if (commits.length !== COMMITS_PER_SESSION) {
    throw new Error(`unexpected commits: ${commits.length}`);
  }
  return elapsed;
}

export async function teardown() {
  if (setupDir !== null) {
    rmSync(setupDir, { recursive: true, force: true });
    setupDir = null;
  }
  sessionIds = [];
}
