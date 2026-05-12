import { Repository } from "@agentgit/core";
import type { Hash } from "@agentgit/core";
import { printDiff } from "../pretty-printer.js";

export function diffCommand(agentgitDir: string, fromHash: Hash, toHash: Hash): void {
  const repo = Repository.open(agentgitDir);
  const diff = repo.diff(fromHash, toHash);
  printDiff(diff);
  repo.index.close();
}
