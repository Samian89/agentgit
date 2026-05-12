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
  /** Injectable prompt function — defaults to readline on stdin/stdout. */
  promptFn?: PromptFn;
}

export class ConfirmationGuard implements Guard {
  readonly name = "ConfirmationGuard";
  private readonly destructiveTools: Set<string>;
  private readonly promptFn: PromptFn;

  constructor(options: ConfirmationGuardOptions = {}) {
    this.destructiveTools = new Set(
      options.destructiveTools ?? DEFAULT_DESTRUCTIVE_TOOLS,
    );
    this.promptFn = options.promptFn ?? defaultPrompt;
  }

  async check(context: GuardContext): Promise<GuardResult> {
    const { toolCall } = context;

    if (!this.destructiveTools.has(toolCall.name)) {
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

async function defaultPrompt(message: string): Promise<string> {
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
