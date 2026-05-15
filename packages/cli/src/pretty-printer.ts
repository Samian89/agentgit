import type { Commit, Session, StepDiff } from "@agentgit/core";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const DIM = "\x1b[2m";

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

export function printLog(
  commits: Commit[],
  sessionMap: Map<string, Session> = new Map(),
): void {
  const sorted = [...commits].sort((a, b) => b.timestamp - a.timestamp);
  for (const c of sorted) {
    const session = sessionMap.get(c.sessionId);
    const hashStr = `${YELLOW}${shortHash(c.hash)}${RESET}`;
    const ts = `${DIM}${formatTimestamp(c.timestamp)}${RESET}`;
    const sess = session ? ` ${CYAN}[${session.name}]${RESET}` : "";
    console.log(`${hashStr} ${ts}${sess}`);
    console.log(`    ${c.message}`);
    if (c.toolCall) {
      console.log(`    ${DIM}tool: ${c.toolCall.name} (${c.toolCall.status})${RESET}`);
    }
    if (c.llmCall) {
      const tokenStr = c.llmCall.usage
        ? `${c.llmCall.usage.totalTokens} tok`
        : "? tok";
      const costStr = c.llmCall.costEstimateUsd !== null
        ? ` ~$${c.llmCall.costEstimateUsd.toFixed(4)}`
        : "";
      console.log(`    ${DIM}${MAGENTA}llm: ${c.llmCall.model} (${tokenStr}${costStr})${RESET}`);
    }
    console.log();
  }
}

export function printDiff(diff: StepDiff): void {
  console.log(`diff ${shortHash(diff.fromHash)}..${shortHash(diff.toHash)}`);
  for (const entry of diff.added) {
    console.log(`${GREEN}+++ ${entry.path} (new, ${entry.sizeDelta ?? 0} bytes)${RESET}`);
  }
  for (const entry of diff.removed) {
    console.log(`${RED}--- ${entry.path} (removed, ${Math.abs(entry.sizeDelta ?? 0)} bytes)${RESET}`);
  }
  for (const entry of diff.modified) {
    const delta = entry.sizeDelta ?? 0;
    const sign = delta >= 0 ? "+" : "";
    console.log(`${CYAN}~~~ ${entry.path} (modified, ${sign}${delta} bytes)${RESET}`);
    console.log(`    ${DIM}from: ${shortHash(entry.fromHash ?? "")}${RESET}`);
    console.log(`    ${DIM}  to: ${shortHash(entry.toHash ?? "")}${RESET}`);
  }
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
    console.log("(no differences)");
  }
}
