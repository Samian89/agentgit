import { Repository } from "@agentgit/core";
import type { Hash } from "@agentgit/core";
import { printDiff } from "../pretty-printer.js";

export function diffCommand(agentgitDir: string, fromHash: Hash, toHash: Hash): void {
  const repo = Repository.open(agentgitDir);

  let resolvedFrom: string | null;
  let resolvedTo: string | null;
  try {
    resolvedFrom = repo.index.resolveHash(fromHash);
    resolvedTo = repo.index.resolveHash(toHash);
  } catch (err) {
    console.error(`fatal: ${String(err)}`);
    repo.index.close();
    process.exit(1);
  }

  if (!resolvedFrom) {
    console.error(`fatal: commit not found: ${fromHash}`);
    repo.index.close();
    process.exit(1);
  }
  if (!resolvedTo) {
    console.error(`fatal: commit not found: ${toHash}`);
    repo.index.close();
    process.exit(1);
  }

  const diff = repo.diff(resolvedFrom, resolvedTo);
  printDiff(diff);
  repo.index.close();
}
