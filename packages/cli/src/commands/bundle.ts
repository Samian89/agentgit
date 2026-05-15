import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createBundleFile,
  importBundleFile,
  Repository,
} from "@agentgit/core";

export interface BundleCreateOptions {
  output?: string;
}

function resolveSession(
  repo: Repository,
  sessionIdOrName: string,
): { id: string; name: string } | null {
  const sessions = repo.index.listSessions();
  const match = sessions.find(
    (s) => s.id === sessionIdOrName || s.name === sessionIdOrName,
  );
  return match ? { id: match.id, name: match.name } : null;
}

/**
 * `agentgit bundle create <session...> [-o file.agentgit-bundle]`
 *
 * If `-o` is omitted the bundle is written to
 * `<first-session-name>.agentgit-bundle` in cwd.
 */
export function bundleCreateCommand(
  agentgitDir: string,
  sessionRefs: string[],
  options: BundleCreateOptions,
): number {
  if (sessionRefs.length === 0) {
    console.error("fatal: bundle create requires at least one session");
    return 1;
  }

  const repo = Repository.open(agentgitDir);
  try {
    const resolved: { id: string; name: string }[] = [];
    for (const ref of sessionRefs) {
      const match = resolveSession(repo, ref);
      if (!match) {
        console.error(`fatal: session not found: ${ref}`);
        return 1;
      }
      resolved.push(match);
    }

    const outPath = options.output
      ? resolve(options.output)
      : resolve(`${resolved[0]!.name}.agentgit-bundle`);

    const result = createBundleFile({
      repo,
      sessionIds: resolved.map((r) => r.id),
      outPath,
    });

    console.log(
      `wrote ${outPath} (${result.bytesWritten} bytes, ${result.commitCount} commit(s), ${result.objectCount} object(s))`,
    );
    return 0;
  } finally {
    repo.index.close();
  }
}

/**
 * `agentgit bundle import <file>`
 *
 * Verifies every object hash and refuses the bundle on any mismatch (no
 * partial writes). Refuses bundles whose schemaVersion exceeds this build's
 * TARGET_VERSION.
 */
export function bundleImportCommand(
  agentgitDir: string,
  filePath: string,
): number {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    console.error(`fatal: bundle file not found: ${abs}`);
    return 1;
  }

  const repo = Repository.open(agentgitDir);
  try {
    const result = importBundleFile({ repo, filePath: abs });
    console.log(
      `imported ${result.commitsInserted} commit(s), ${result.sessionsInserted} session(s), ${result.refsInserted} ref(s) from ${abs}`,
    );
    console.log(
      `bundle format v${result.manifest.formatVersion}, schema v${result.manifest.schemaVersion}, generator ${result.manifest.generator}`,
    );
    return 0;
  } catch (err) {
    console.error(`fatal: ${(err as Error).message}`);
    return 1;
  } finally {
    repo.index.close();
  }
}
