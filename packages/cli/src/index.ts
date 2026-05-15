#!/usr/bin/env node
import { Command } from "commander";
import { requireAgentGitDir } from "./find-root.js";
import { initCommand } from "./commands/init.js";
import { logCommand } from "./commands/log.js";
import { diffCommand } from "./commands/diff.js";
import { branchCommand } from "./commands/branch.js";
import { checkoutCommand } from "./commands/checkout.js";
import { replayCommand } from "./commands/replay.js";
import { exportCommand } from "./commands/export.js";
import { configCommand } from "./commands/config.js";
import { migrateCommand } from "./commands/migrate.js";
import { verifyCommand } from "./commands/verify.js";
import { gcCommand } from "./commands/gc.js";
import { fsckCommand } from "./commands/fsck.js";
import {
  bundleCreateCommand,
  bundleImportCommand,
} from "./commands/bundle.js";
import { mergeBaseCommand } from "./commands/merge-base.js";
import { cherryPickCommand } from "./commands/cherry-pick.js";
import {
  remoteAddCommand,
  remoteListCommand,
  remoteRemoveCommand,
} from "./commands/remote.js";
import { pushCommand } from "./commands/push.js";
import { fetchCommand } from "./commands/fetch.js";
import { pullCommand } from "./commands/pull.js";

const program = new Command();

program
  .name("agentgit")
  .description("Local-first git for AI agents")
  .version("0.1.0");

program
  .command("init [dir]")
  .description("Initialize a new .agentgit/ repository")
  .action((dir?: string) => {
    initCommand(dir);
  });

program
  .command("log")
  .description("List commits in reverse chronological order")
  .option("-s, --session <id>", "Filter by session ID or name")
  .option("--llm-only", "Show only LLM commits (hides commits without an llmCall)")
  .option("--tool-only", "Show only tool commits (hides commits without a toolCall)")
  .action((options: { session?: string; llmOnly?: boolean; toolOnly?: boolean }) => {
    const agentgitDir = requireAgentGitDir();
    logCommand(agentgitDir, options);
  });

program
  .command("diff <hash1> <hash2>")
  .description("Show step-level diff between two commits")
  .action((hash1: string, hash2: string) => {
    const agentgitDir = requireAgentGitDir();
    diffCommand(agentgitDir, hash1, hash2);
  });

program
  .command("branch <name> <commitHash>")
  .description("Create a branch pointing to a commit")
  .action((name: string, commitHash: string) => {
    const agentgitDir = requireAgentGitDir();
    branchCommand(agentgitDir, name, commitHash);
  });

program
  .command("checkout <hash>")
  .description("Restore agent state snapshot to .agentgit/CHECKOUT")
  .action((hash: string) => {
    const agentgitDir = requireAgentGitDir();
    checkoutCommand(agentgitDir, hash);
  });

program
  .command("replay <session>")
  .description("Print recorded tool calls for a session in sequence")
  .option("--full", "Do not truncate prompt/response text (default truncates at 500 chars)")
  .action((session: string, options: { full?: boolean }) => {
    const agentgitDir = requireAgentGitDir();
    replayCommand(agentgitDir, session, options);
  });

program
  .command("export <session>")
  .description("Export session as replay JSON to stdout")
  .action((session: string) => {
    const agentgitDir = requireAgentGitDir();
    exportCommand(agentgitDir, session);
  });

program
  .command("config [key] [value]")
  .description("Get, set, or list AgentGit config (e.g. user.name, user.email)")
  .option("-l, --list", "Print the entire config as JSON")
  .action((key: string | undefined, value: string | undefined, options: { list?: boolean }) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(configCommand(agentgitDir, key, value, options));
  });

program
  .command("migrate")
  .description("Apply pending schema migrations to .agentgit/index.db")
  .option("--check", "Report pending migrations and exit non-zero if any are pending")
  .action((options: { check?: boolean }) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(migrateCommand(agentgitDir, options));
  });

program
  .command("verify <hash>")
  .description("Verify the Ed25519 signature of a commit")
  .action((hash: string) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(verifyCommand(agentgitDir, hash));
  });

program
  .command("gc")
  .description(
    "Reclaim unreachable objects (soft-delete to objects.gc/, then prune after --prune-older-than)",
  )
  .option(
    "--prune-older-than <duration>",
    "Hard-delete files in objects.gc/ older than this (default 30d). Accepts ms/s/m/h/d suffix; bare numbers are days.",
  )
  .option("--dry-run", "Print actions without modifying the filesystem")
  .option("--force", "Run even if an active session is present")
  .action(
    (options: { pruneOlderThan?: string; dryRun?: boolean; force?: boolean }) => {
      const agentgitDir = requireAgentGitDir();
      process.exit(gcCommand(agentgitDir, options));
    },
  );

program
  .command("fsck")
  .description(
    "Verify object hashes, cross-check the index, and validate schema version",
  )
  .option("--json", "Emit machine-readable JSON instead of human-readable text")
  .option(
    "--repair",
    "Quarantine corrupt files to objects.corrupt/ and drop safe orphan rows",
  )
  .action((options: { json?: boolean; repair?: boolean }) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(fsckCommand(agentgitDir, options));
  });

const bundle = program
  .command("bundle")
  .description("Pack a session into a portable .agentgit-bundle or import one");

bundle
  .command("create <session...>")
  .description("Pack one or more sessions into a .agentgit-bundle file")
  .option("-o, --output <file>", "Output path (default: <session>.agentgit-bundle)")
  .action((sessions: string[], options: { output?: string }) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(bundleCreateCommand(agentgitDir, sessions, options));
  });

bundle
  .command("import <file>")
  .description("Restore a .agentgit-bundle into the current repository")
  .action((file: string) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(bundleImportCommand(agentgitDir, file));
  });

program
  .command("merge-base <a> <b>")
  .description(
    "Print the lowest common ancestor of two refs (branch names or commit hashes)",
  )
  .action((a: string, b: string) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(mergeBaseCommand(agentgitDir, a, b));
  });

program
  .command("cherry-pick <source>")
  .description(
    "Replay commits from <source> onto --onto <target>, producing new commits with fresh hashes",
  )
  .requiredOption("--onto <target>", "Target ref to replay onto")
  .option(
    "--session <name>",
    "Create a new session for the replayed commits instead of appending to the target session",
  )
  .action((source: string, options: { onto: string; session?: string }) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(cherryPickCommand(agentgitDir, source, options));
  });

const remote = program
  .command("remote")
  .description("Manage configured remotes (add, list, remove)");

remote
  .command("add <name> <url>")
  .description("Add a named remote with optional bearer token")
  .option("--token <token>", "Bearer token issued by the remote server")
  .action((name: string, url: string, options: { token?: string }) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(remoteAddCommand(agentgitDir, name, url, options));
  });

remote
  .command("list")
  .description("List configured remotes")
  .action(() => {
    const agentgitDir = requireAgentGitDir();
    process.exit(remoteListCommand(agentgitDir));
  });

remote
  .command("remove <name>")
  .description("Remove a configured remote")
  .action((name: string) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(remoteRemoveCommand(agentgitDir, name));
  });

program
  .command("push <remote> <session>")
  .description("Push a session to a remote (uploads only objects the server is missing)")
  .option("--token <token>", "Override the remote's configured token")
  .action(async (remoteName: string, sessionRef: string, options: { token?: string }) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(await pushCommand(agentgitDir, remoteName, sessionRef, options));
  });

program
  .command("fetch <remote> [refs...]")
  .description("Fetch refs from a remote, updating refs/remotes/<remote>/<ref>")
  .option("--token <token>", "Override the remote's configured token")
  .action(async (remoteName: string, refs: string[], options: { token?: string }) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(
      await fetchCommand(
        agentgitDir,
        remoteName,
        refs && refs.length > 0 ? refs : undefined,
        options,
      ),
    );
  });

program
  .command("pull <remote> <ref>")
  .description("Fetch a ref and fast-forward the local session ref (refuses non-FF)")
  .option("--token <token>", "Override the remote's configured token")
  .action(async (remoteName: string, refName: string, options: { token?: string }) => {
    const agentgitDir = requireAgentGitDir();
    process.exit(await pullCommand(agentgitDir, remoteName, refName, options));
  });

program.parse(process.argv);
