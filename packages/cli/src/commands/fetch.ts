import { Repository, fetchRefs } from "@agentgit/core";
import { getRemote } from "./remote.js";

export interface FetchCommandOptions {
  token?: string;
}

/** `agentgit fetch <remote> [<ref>...]` */
export async function fetchCommand(
  agentgitDir: string,
  remoteName: string,
  refNames: string[] | undefined,
  options: FetchCommandOptions = {},
): Promise<number> {
  const remote = getRemote(agentgitDir, remoteName);
  if (!remote) {
    console.error(`fetch: unknown remote '${remoteName}'`);
    return 1;
  }
  const token = options.token ?? remote.token;
  if (!token) {
    console.error(`fetch: no token configured for remote '${remoteName}'`);
    return 1;
  }
  const repo = Repository.open(agentgitDir);
  try {
    const opts: Parameters<typeof fetchRefs>[1] = {
      remote: remoteName,
      baseUrl: remote.url,
      token,
    };
    if (refNames !== undefined && refNames.length > 0) {
      opts.refNames = refNames;
    }
    const result = await fetchRefs(repo, opts);
    process.stdout.write(
      `Fetched ${result.downloadedObjects} objects, ${result.fetchedRefs.length} refs from ${remoteName}\n`,
    );
    for (const r of result.fetchedRefs) {
      process.stdout.write(`  ${r.name} → ${r.target.slice(0, 12)} (local: ${r.localName})\n`);
    }
    return 0;
  } catch (err) {
    console.error(`fetch: ${(err as Error).message}`);
    return 1;
  }
}
