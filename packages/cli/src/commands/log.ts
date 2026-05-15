import { Repository } from "@agentgit/core";
import type { Session } from "@agentgit/core";
import { printLog } from "../pretty-printer.js";

export interface LogOptions {
  session?: string;
  llmOnly?: boolean;
  toolOnly?: boolean;
}

export function logCommand(agentgitDir: string, options: LogOptions = {}): void {
  const repo = Repository.open(agentgitDir);
  const sessions = repo.index.listSessions();

  if (sessions.length === 0) {
    console.log("No sessions found.");
    repo.index.close();
    return;
  }

  const targetSessions = options.session
    ? sessions.filter((s) => s.id === options.session || s.name === options.session)
    : sessions;

  if (targetSessions.length === 0) {
    console.error(`Session not found: ${options.session}`);
    repo.index.close();
    process.exit(1);
  }

  const allCommits = targetSessions.flatMap((s) => repo.log(s.id));

  let commitsToPrint = allCommits;
  if (options.llmOnly) {
    commitsToPrint = commitsToPrint.filter((c) => c.llmCall != null);
  }
  if (options.toolOnly) {
    commitsToPrint = commitsToPrint.filter((c) => c.toolCall != null);
  }

  if (commitsToPrint.length === 0) {
    console.log("No commits found.");
    repo.index.close();
    return;
  }

  const sessionMap = new Map<string, Session>(sessions.map((s) => [s.id, s]));
  printLog(commitsToPrint, sessionMap);
  repo.index.close();
}
