import type { ObjectStore } from "../object-store.js";
import type { ToolCall } from "../types.js";
export interface GuardContext {
    toolCall: ToolCall;
    objectStore?: ObjectStore;
}
export type GuardOutcome = "allow" | "block";
export interface GuardResult {
    outcome: GuardOutcome;
    reason?: string;
    snapshotHash?: string;
}
export interface Guard {
    readonly name: string;
    check(context: GuardContext): Promise<GuardResult>;
}
export type PromptFn = (message: string) => Promise<string>;
export type ReadFileFn = (filePath: string) => Promise<string | null>;
export interface GuardConfig {
    confirmationGuard?: {
        enabled?: boolean;
        /** Tool names treated as destructive. Defaults to ["deleteFile", "rm", "shell"]. */
        destructiveTools?: string[];
    };
    snapshotGuard?: {
        enabled?: boolean;
        /** Tool names that mutate files. Defaults to common write-file tool names. */
        writeTools?: string[];
    };
}
//# sourceMappingURL=types.d.ts.map