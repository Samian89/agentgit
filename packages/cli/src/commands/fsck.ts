import { fsck, type FsckIssue } from "@agentgit/core";

export interface FsckCommandOptions {
  /** Emit machine-readable JSON to stdout instead of human text. */
  json?: boolean;
  /** Apply safe repairs (quarantine corrupt files, drop orphan refs). */
  repair?: boolean;
}

/**
 * `agentgit fsck [--json] [--repair]`
 *
 * Exit codes:
 *   0  — no errors detected.
 *   1  — at least one error (corrupt object, missing object referenced by
 *        the index, FK violation, schema-version drift). --repair runs first
 *        but does NOT clear the report; corrupt files still count as errors.
 *
 * The command intentionally does NOT call `Repository.open()` first.
 * `Repository.open()` triggers auto-migration, which would silently bring
 * the schema to TARGET_VERSION before fsck ever runs — masking exactly the
 * "this repo is on an old schema" drift that fsck is supposed to surface.
 *
 * Error formatting is delegated entirely to fsck: a missing index.db (or
 * any other early-bail condition) is returned as a structured FsckReport
 * with `errors: [{ type: 'missing-index-db', ... }]`. With `--json`, that
 * report is serialised to stdout exactly like the success path, so callers
 * piping the output through `jq` always receive valid JSON.
 */
export function fsckCommand(
  agentgitDir: string,
  options: FsckCommandOptions = {},
): number {
  const fsckOpts: Parameters<typeof fsck>[1] = {};
  if (options.repair !== undefined) fsckOpts.repair = options.repair;
  const report = fsck(agentgitDir, fsckOpts);

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    printHuman(report.stats, report.errors, report.warnings, report.schema);
  }
  return report.ok ? 0 : 1;
}

function printHuman(
  stats: { objects: number; commits: number; blobs: number; refs: number },
  errors: FsckIssue[],
  warnings: FsckIssue[],
  schema: { current: number; target: number },
): void {
  console.log(
    `scanned ${stats.objects} objects · ${stats.commits} commits · ${stats.blobs} blobs · ${stats.refs} refs`,
  );
  console.log(`schema version: ${schema.current} (target ${schema.target})`);
  for (const e of errors) {
    const tag = e.repaired ? "REPAIRED" : "ERROR   ";
    console.log(`${tag} [${e.type}] ${e.message}`);
  }
  for (const w of warnings) {
    console.log(`WARNING  [${w.type}] ${w.message}`);
  }
  if (errors.length === 0 && warnings.length === 0) {
    console.log("ok.");
  } else {
    console.log(
      `${errors.length} error(s), ${warnings.length} warning(s).`,
    );
  }
}
