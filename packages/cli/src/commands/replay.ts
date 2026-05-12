import { Repository } from "@agentgit/core";

export function replayCommand(agentgitDir: string, sessionIdOrName: string): void {
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

  if (commits.length === 0) {
    console.log("No commits to replay.");
    repo.index.close();
    return;
  }

  console.log(`Replaying session: ${session.name} (${session.id})`);
  console.log(`Total steps: ${commits.length}`);
  console.log();

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]!;
    console.log(`Step ${i + 1}/${commits.length}: ${commit.message}`);
    if (commit.toolCall) {
      const tc = commit.toolCall;
      console.log(`  Tool: ${tc.name}`);
      console.log(
        `  Input: ${JSON.stringify(tc.input, null, 2).split("\n").join("\n  ")}`,
      );
      if (tc.output !== null) {
        const outputStr =
          typeof tc.output === "string"
            ? tc.output
            : JSON.stringify(tc.output, null, 2);
        console.log(`  Output: ${outputStr.split("\n").join("\n  ")}`);
      }
      console.log(`  Status: ${tc.status}`);
    }
    console.log();
  }

  repo.index.close();
}
