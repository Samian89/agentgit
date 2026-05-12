import { Repository } from "@agentgit/core";
import type { ReplayExport } from "../types.js";

export function exportCommand(agentgitDir: string, sessionIdOrName: string): void {
  const repo = Repository.open(agentgitDir);
  const sessions = repo.index.listSessions();
  const session = sessions.find(
    (s) => s.id === sessionIdOrName || s.name === sessionIdOrName,
  );

  if (!session) {
    console.error(`Session not found: ${sessionIdOrName}`);
    repo.index.close();
    process.exit(1);
  }

  const commits = repo.log(session.id);

  const payload: ReplayExport = {
    version: "1",
    sessionId: session.id,
    sessionName: session.name,
    exportedAt: Date.now(),
    commits: commits.map((commit) => {
      const treeEntries = repo.index.getTreeEntries(commit.tree);
      return {
        hash: commit.hash,
        timestamp: commit.timestamp,
        message: commit.message,
        toolCall: commit.toolCall,
        stateSnapshot: treeEntries.map((e) => ({
          path: e.path,
          blobHash: e.blobHash,
          size: e.size,
        })),
      };
    }),
  };

  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  repo.index.close();
}
