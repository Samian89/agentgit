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
  .action((options: { session?: string }) => {
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
  .action((session: string) => {
    const agentgitDir = requireAgentGitDir();
    replayCommand(agentgitDir, session);
  });

program
  .command("export <session>")
  .description("Export session as replay JSON to stdout")
  .action((session: string) => {
    const agentgitDir = requireAgentGitDir();
    exportCommand(agentgitDir, session);
  });

program.parse(process.argv);
