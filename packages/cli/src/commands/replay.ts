import { Repository } from "@agentgit/core";

export interface ReplayOptions {
  full?: boolean;
}

function truncate(str: string, max = 500): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}

export function replayCommand(
  agentgitDir: string,
  sessionIdOrName: string,
  options: ReplayOptions = {},
): void {
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
    if (commit.llmCall) {
      const lc = commit.llmCall;
      console.log(`  LLM: ${lc.model} (${lc.provider})`);
      if (lc.usage) {
        console.log(
          `    Tokens: ${lc.usage.promptTokens} prompt / ${lc.usage.completionTokens} completion / ${lc.usage.totalTokens} total`,
        );
      }
      if (lc.costEstimateUsd !== null) {
        console.log(`    Cost:   ~$${lc.costEstimateUsd.toFixed(4)}`);
      }
      if (lc.durationMs !== null) {
        console.log(`    Duration: ${lc.durationMs}ms`);
      }
      console.log(`    Prompt:`);
      const lastUser = [...lc.messages].reverse().find((m) => m.role === "user");
      const promptText = lastUser ? lastUser.content : (lc.messages[lc.messages.length - 1]?.content ?? "");
      const promptOut = options.full ? promptText : truncate(promptText);
      const indentedPrompt = promptOut
        ? promptOut.split("\n").map((line) => `      ${line}`).join("\n")
        : "      (empty)";
      console.log(indentedPrompt);
      console.log(`    Response:`);
      const respText = lc.response ?? "";
      const respOut = options.full ? respText : truncate(respText);
      const indentedResp = respOut
        ? respOut.split("\n").map((line) => `      ${line}`).join("\n")
        : "      (empty)";
      console.log(indentedResp);
      console.log(`    Status: ${lc.status}`);
      if (lc.error) {
        console.log(`    Error: ${lc.error}`);
      }
    }
    console.log();
  }

  repo.index.close();
}
