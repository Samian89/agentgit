import { Repository } from "@agentgit/core";
import type { Hash } from "@agentgit/core";
import { shortHash } from "../pretty-printer.js";

export function branchCommand(agentgitDir: string, name: string, commitHash: Hash): void {
  const repo = Repository.open(agentgitDir);
  repo.createBranch(name, commitHash);
  console.log(`Branch '${name}' created at ${shortHash(commitHash)}`);
  repo.index.close();
}
