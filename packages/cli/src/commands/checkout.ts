import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Repository } from "@agentgit/core";
import type { Hash } from "@agentgit/core";
import { shortHash } from "../pretty-printer.js";

export interface CheckoutSnapshot {
  commitHash: Hash;
  timestamp: number;
  message: string;
  files: Array<{
    path: string;
    blobHash: string;
    size: number;
    content: string;
    encoding: string;
  }>;
}

export function checkoutCommand(agentgitDir: string, commitHash: Hash): void {
  const repo = Repository.open(agentgitDir);
  const commit = repo.index.getCommit(commitHash);

  if (!commit) {
    console.error(`fatal: commit not found: ${commitHash}`);
    repo.index.close();
    process.exit(1);
  }

  const treeEntries = repo.index.getTreeEntries(commit.tree);
  const files = treeEntries.map((entry) => {
    const blobObj = repo.objects.read(entry.blobHash) as {
      content: string;
      encoding: string;
    };
    return {
      path: entry.path,
      blobHash: entry.blobHash,
      size: entry.size,
      content: blobObj.content,
      encoding: blobObj.encoding ?? "utf-8",
    };
  });

  const snapshot: CheckoutSnapshot = {
    commitHash,
    timestamp: commit.timestamp,
    message: commit.message,
    files,
  };

  const checkoutPath = join(agentgitDir, "CHECKOUT");
  writeFileSync(checkoutPath, JSON.stringify(snapshot, null, 2), "utf-8");
  console.log(`HEAD is now at ${shortHash(commitHash)} ${commit.message}`);
  console.log(`Snapshot written to ${checkoutPath}`);
  repo.index.close();
}
