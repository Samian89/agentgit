import { Repository } from "@agentgit/core";
import { shortHash } from "../pretty-printer.js";

export interface CherryPickCliOptions {
  onto: string;
  session?: string;
}

/**
 * `agentgit cherry-pick <source> --onto <target> [--session <name>]`
 *
 * Replays the commits between `mergeBase(source, target)` and `source` on
 * top of `target`. Each replayed commit reuses the source's tool call,
 * message, and metadata, with `cherryPickedFrom` added to metadata and a
 * fresh hash from the new parent.
 *
 * Path-level conflicts exit non-zero with a sorted list of paths and write
 * source-side blob content to `.agentgit/CONFLICT/<path>` for manual
 * inspection. No partial mutation is committed to the target session.
 */
export function cherryPickCommand(
  agentgitDir: string,
  sourceRef: string,
  options: CherryPickCliOptions,
): number {
  if (!options.onto) {
    console.error("fatal: --onto <target-ref> is required");
    return 2;
  }
  const repo = Repository.open(agentgitDir);
  try {
    const result = repo.cherryPick({
      sourceRef,
      targetRef: options.onto,
      ...(options.session !== undefined ? { sessionName: options.session } : {}),
    });

    switch (result.status) {
      case "ok": {
        if (result.newCommits.length === 0) {
          console.log("Nothing to cherry-pick.");
          return 0;
        }
        console.log(
          `Cherry-picked ${result.newCommits.length} commit(s) onto ${shortHash(
            options.onto,
          )}; new head ${shortHash(result.newHead)}`,
        );
        for (const hash of result.newCommits) {
          console.log(`  ${shortHash(hash)}`);
        }
        return 0;
      }
      case "noop": {
        console.log(`Nothing to cherry-pick: ${result.reason}.`);
        return 0;
      }
      case "conflict": {
        const baseSuffix = result.mergeBase
          ? ` since merge base ${shortHash(result.mergeBase)}`
          : " (no common ancestor — disjoint histories)";
        console.error(
          `error: cherry-pick aborted; ${result.conflicts.length} path(s) conflict between source and target${baseSuffix}:`,
        );
        for (const p of result.conflicts) {
          console.error(`  ${p}`);
        }
        console.error(`source-side blobs written to ${result.conflictDir}`);
        if (result.unsafePaths.length > 0) {
          console.error(
            `warning: ${result.unsafePaths.length} path(s) were not materialised under CONFLICT/ because they would escape it:`,
          );
          for (const p of result.unsafePaths) {
            console.error(`  ${p}`);
          }
        }
        console.error("target session is unchanged.");
        return 1;
      }
      case "error": {
        console.error(`fatal: ${result.message}`);
        return 1;
      }
    }
  } finally {
    repo.index.close();
  }
}
