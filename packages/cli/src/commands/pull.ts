import { Repository, pullRef } from "@agentgit/core";
import { getRemote } from "./remote.js";

export interface PullCommandOptions {
  token?: string;
}

/**
 * `agentgit pull <remote> <ref>` — fast-forward-only.
 * Refuses non-FF updates until merge support lands (spec 006).
 */
export async function pullCommand(
  agentgitDir: string,
  remoteName: string,
  refName: string,
  options: PullCommandOptions = {},
): Promise<number> {
  const remote = getRemote(agentgitDir, remoteName);
  if (!remote) {
    console.error(`pull: unknown remote '${remoteName}'`);
    return 1;
  }
  const token = options.token ?? remote.token;
  if (!token) {
    console.error(`pull: no token configured for remote '${remoteName}'`);
    return 1;
  }
  const repo = Repository.open(agentgitDir);
  try {
    const result = await pullRef(repo, {
      remote: remoteName,
      baseUrl: remote.url,
      token,
      refName,
    });
    if (result.upToDate) {
      process.stdout.write(`Already up to date (${refName})\n`);
    } else {
      process.stdout.write(
        `Pulled ${result.downloadedObjects} objects, ${result.localRef.name} → ${result.localRef.target.slice(0, 12)}\n`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`pull: ${(err as Error).message}`);
    return 1;
  }
}
