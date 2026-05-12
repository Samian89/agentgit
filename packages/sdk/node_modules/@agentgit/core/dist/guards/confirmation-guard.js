import * as readline from "node:readline/promises";
const DEFAULT_DESTRUCTIVE_TOOLS = ["deleteFile", "rm", "shell"];
export class ConfirmationGuard {
    name = "ConfirmationGuard";
    destructiveTools;
    promptFn;
    constructor(options = {}) {
        this.destructiveTools = new Set(options.destructiveTools ?? DEFAULT_DESTRUCTIVE_TOOLS);
        this.promptFn = options.promptFn ?? defaultPrompt;
    }
    async check(context) {
        const { toolCall } = context;
        if (!this.destructiveTools.has(toolCall.name)) {
            return { outcome: "allow" };
        }
        const answer = await this.promptFn(`Guard: "${toolCall.name}" is a destructive tool call. Proceed? [y/N] `);
        if (answer.trim().toLowerCase() === "y") {
            return { outcome: "allow" };
        }
        return {
            outcome: "block",
            reason: `User did not confirm destructive tool call: ${toolCall.name}`,
        };
    }
}
async function defaultPrompt(message) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        return await rl.question(message);
    }
    finally {
        rl.close();
    }
}
//# sourceMappingURL=confirmation-guard.js.map