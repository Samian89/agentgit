import type { ObjectStore } from "../object-store.js";
import type { ToolCall } from "../types.js";
import type { Guard, GuardResult } from "./types.js";
/**
 * Runs a chain of guards against a tool call in registration order.
 * Stops at the first blocking guard; all snapshot hashes from passing guards
 * are surfaced in the final result.
 */
export declare class GuardRegistry {
    private readonly guards;
    constructor(guards: Guard[]);
    runGuards(toolCall: ToolCall, objectStore?: ObjectStore): Promise<GuardResult>;
    get size(): number;
}
//# sourceMappingURL=registry.d.ts.map