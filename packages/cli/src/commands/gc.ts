import { Repository } from "@agentgit/core";

export interface GcCommandOptions {
  /** Duration string for hard-prune cutoff, e.g. "30d", "12h", "0d". */
  pruneOlderThan?: string;
  /** Compute and print actions but do not modify the filesystem. */
  dryRun?: boolean;
  /** Override the active-session safety check. */
  force?: boolean;
}

/**
 * Parse a duration string into milliseconds. Accepts `<n><unit>` where
 * unit is one of: `ms`, `s`, `m`, `h`, `d`. A bare number is treated as days.
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `invalid duration '${input}': expected <number>[ms|s|m|h|d]`,
    );
  }
  const n = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
    case undefined:
    case "d":
    default:
      return n * 24 * 60 * 60 * 1000;
  }
}

/**
 * `agentgit gc [--prune-older-than=30d] [--dry-run] [--force]`
 *
 * Exit codes:
 *   0  — gc completed (including dry-run with no changes pending).
 *   1  — refused to run because an active session exists and --force was
 *        not passed.
 */
export function gcCommand(
  agentgitDir: string,
  options: GcCommandOptions = {},
): number {
  const repo = Repository.open(agentgitDir);
  try {
    let pruneOlderThanMs: number | undefined;
    if (options.pruneOlderThan !== undefined) {
      try {
        pruneOlderThanMs = parseDuration(options.pruneOlderThan);
      } catch (err) {
        console.error(
          `fatal: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }

    const gcOpts: Parameters<typeof repo.gc>[0] = {};
    if (pruneOlderThanMs !== undefined) gcOpts.pruneOlderThanMs = pruneOlderThanMs;
    if (options.dryRun !== undefined) gcOpts.dryRun = options.dryRun;
    if (options.force !== undefined) gcOpts.force = options.force;
    const result = repo.gc(gcOpts);

    if (result.refusedActiveSessions) {
      console.error(
        `fatal: refusing to gc — ${result.refusedActiveSessions.length} active session(s) detected:`,
      );
      for (const id of result.refusedActiveSessions) {
        console.error(`  - ${id}`);
      }
      console.error("re-run with --force once the sessions are completed.");
      return 1;
    }

    const verb = result.dryRun ? "would " : "";
    console.log(
      `${result.scanned} object(s) scanned, ${result.reachable} reachable.`,
    );
    if (result.hardDeleted.length > 0) {
      console.log(
        `${verb}hard-delete ${result.hardDeleted.length} object(s) from objects.gc/`,
      );
    }
    if (result.softDeleted.length > 0) {
      console.log(
        `${verb}soft-delete ${result.softDeleted.length} unreachable object(s) → objects.gc/`,
      );
    }
    if (result.softDeleted.length === 0 && result.hardDeleted.length === 0) {
      console.log("nothing to do.");
    }
    return 0;
  } finally {
    repo.index.close();
  }
}
