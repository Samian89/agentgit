import { Repository } from "@agentgit/core";

/**
 * `agentgit verify <hash>`
 *
 * Exit codes:
 *   0  — commit signature is valid OR commit is unsigned (informational).
 *   1  — commit not found, content tampered, or signature does not verify.
 *
 * Acceptance criterion treats "unsigned" as informational; tampered/invalid
 * signatures must exit non-zero so CI / scripts catch them.
 */
export function verifyCommand(agentgitDir: string, hash: string): number {
  const repo = Repository.open(agentgitDir);
  try {
    const resolved = repo.index.resolveHash(hash);
    if (!resolved) {
      console.error(`fatal: no commit matches '${hash}'`);
      return 1;
    }
    const { status, commit } = repo.verifyCommit(resolved);
    const short = resolved.slice(0, 12);
    switch (status) {
      case "valid":
        console.log(`commit ${short}: signature OK (key ${commit?.publicKey?.slice(0, 16)}…)`);
        return 0;
      case "unsigned":
        console.log(`commit ${short}: unsigned`);
        return 0;
      case "invalid":
        console.error(`commit ${short}: BAD SIGNATURE`);
        return 1;
      case "tampered":
        console.error(`commit ${short}: TAMPERED — content hash does not match`);
        return 1;
      case "not-found":
        console.error(`commit ${short}: not found in index`);
        return 1;
    }
  } finally {
    repo.index.close();
  }
}
