import * as readline from "node:readline/promises";
import type { Guard, GuardContext, GuardResult, PromptFn } from "./types.js";

const DEFAULT_DESTRUCTIVE_TOOLS = [
  "deleteFile",
  "delete_file",
  "removeFile",
  "remove_file",
  "rm",
  "shell",
  "bash",
  "Bash",
  "execute_bash",
  "run_bash",
  "run_command",
  "exec",
];

export interface ConfirmationGuardOptions {
  destructiveTools?: string[];
  /**
   * Tool names or input substrings that bypass the destructive check entirely
   * (allow without prompting).
   */
  allowlist?: string[];
  /**
   * Tool names or input substrings that are unconditionally blocked, even if
   * the user would have approved.
   */
  denylist?: string[];
  /**
   * Tool names or input substrings that are auto-confirmed: treated as
   * destructive but allowed without invoking the prompt.
   */
  autoConfirm?: string[];
  /** Injectable prompt function — defaults to readline on stdin/stdout. */
  promptFn?: PromptFn;
}

export class ConfirmationGuard implements Guard {
  readonly name = "ConfirmationGuard";
  private readonly destructiveTools: Set<string>;
  private readonly allowlist: string[];
  private readonly denylist: string[];
  private readonly autoConfirm: string[];
  private readonly promptFn: PromptFn;

  constructor(options: ConfirmationGuardOptions = {}) {
    this.destructiveTools = new Set(
      options.destructiveTools ?? DEFAULT_DESTRUCTIVE_TOOLS,
    );
    this.allowlist = options.allowlist ?? [];
    this.denylist = options.denylist ?? [];
    this.autoConfirm = options.autoConfirm ?? [];
    this.promptFn = options.promptFn ?? defaultPrompt;
  }

  async check(context: GuardContext): Promise<GuardResult> {
    const { toolCall } = context;

    if (matchesAny(toolCall, this.denylist)) {
      return {
        outcome: "block",
        reason: `Tool call '${toolCall.name}' matched denylist`,
      };
    }

    if (matchesAny(toolCall, this.allowlist)) {
      return { outcome: "allow" };
    }

    if (!this.destructiveTools.has(toolCall.name)) {
      return { outcome: "allow" };
    }

    if (matchesAny(toolCall, this.autoConfirm)) {
      return { outcome: "allow" };
    }

    const answer = await this.promptFn(
      `Guard: "${toolCall.name}" is a destructive tool call. Proceed? [y/N] `,
    );

    if (answer.trim().toLowerCase() === "y") {
      return { outcome: "allow" };
    }

    return {
      outcome: "block",
      reason: `User did not confirm destructive tool call: ${toolCall.name}`,
    };
  }
}

/**
 * True when `toolCall.name` exactly equals a pattern OR any string-valued
 * input field contains a pattern as a substring. Substring matching on
 * input strings is what lets a denylist entry like `"rm -rf"` block a
 * `bash` call with `args: ["rm -rf /tmp/x"]`.
 */
function matchesAny(
  toolCall: { name: string; input: Record<string, unknown> },
  patterns: string[],
): boolean {
  if (patterns.length === 0) return false;
  if (patterns.includes(toolCall.name)) return true;
  for (const value of Object.values(toolCall.input)) {
    if (stringContainsAny(value, patterns)) return true;
  }
  return false;
}

function stringContainsAny(value: unknown, patterns: string[]): boolean {
  if (typeof value === "string") {
    return patterns.some((p) => value.includes(p));
  }
  if (Array.isArray(value)) {
    return value.some((v) => stringContainsAny(v, patterns));
  }
  return false;
}

async function defaultPrompt(message: string): Promise<string> {
  // In non-interactive environments (no TTY on stdin), block by default
  // rather than hanging on readline. This is the safe answer for a
  // long-running agent process with no human in the loop.
  if (!process.stdin.isTTY) {
    return "n";
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}
