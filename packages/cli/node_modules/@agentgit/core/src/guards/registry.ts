import type { ObjectStore } from "../object-store.js";
import type { ToolCall } from "../types.js";
import type { Guard, GuardContext, GuardResult } from "./types.js";

/**
 * Runs a chain of guards against a tool call in registration order.
 * Stops at the first blocking guard; all snapshot hashes from passing guards
 * are surfaced in the final result.
 */
export class GuardRegistry {
  constructor(private readonly guards: Guard[]) {}

  async runGuards(
    toolCall: ToolCall,
    objectStore?: ObjectStore,
  ): Promise<GuardResult> {
    const context: GuardContext =
      objectStore !== undefined ? { toolCall, objectStore } : { toolCall };
    const snapshotHashes: string[] = [];

    for (const guard of this.guards) {
      const result = await guard.check(context);

      if (result.snapshotHash !== undefined) {
        snapshotHashes.push(result.snapshotHash);
      }

      if (result.outcome === "block") {
        return result;
      }
    }

    const combined: GuardResult = { outcome: "allow" };
    const lastHash = snapshotHashes[snapshotHashes.length - 1];
    if (lastHash !== undefined) {
      combined.snapshotHash = lastHash;
    }
    return combined;
  }

  get size(): number {
    return this.guards.length;
  }
}
