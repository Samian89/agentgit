import type { Guard, GuardContext, GuardResult, PromptFn } from "./types.js";
export interface ConfirmationGuardOptions {
    destructiveTools?: string[];
    /** Injectable prompt function — defaults to readline on stdin/stdout. */
    promptFn?: PromptFn;
}
export declare class ConfirmationGuard implements Guard {
    readonly name = "ConfirmationGuard";
    private readonly destructiveTools;
    private readonly promptFn;
    constructor(options?: ConfirmationGuardOptions);
    check(context: GuardContext): Promise<GuardResult>;
}
//# sourceMappingURL=confirmation-guard.d.ts.map