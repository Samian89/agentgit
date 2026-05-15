import { performance } from "node:perf_hooks";
import type { ObjectStore } from "../object-store.js";
import { safeRecord, type Reporter } from "../telemetry/reporter.js";
import type { ToolCall } from "../types.js";
import type { Guard, GuardContext, GuardResult } from "./types.js";

/**
 * Runs a chain of guards against a tool call in registration order.
 * Stops at the first blocking guard; all snapshot hashes from passing guards
 * are surfaced in the final result.
 *
 * @public
 */
export class GuardRegistry {
  /**
   * @param guards - chain to evaluate, in order.
   * @param reporter - optional telemetry sink; emits one `guard.evaluate` span
   *   per `runGuards` call when present.
   */
  constructor(
    private readonly guards: Guard[],
    private readonly reporter: Reporter | null = null,
  ) {}

  async runGuards(
    toolCall: ToolCall,
    objectStore?: ObjectStore,
  ): Promise<GuardResult> {
    const t0 = performance.now();
    const context: GuardContext =
      objectStore !== undefined ? { toolCall, objectStore } : { toolCall };
    const snapshotHashes: string[] = [];

    let blocked = false;
    let final: GuardResult = { outcome: "allow" };
    for (const guard of this.guards) {
      const result = await guard.check(context);

      if (result.snapshotHash !== undefined) {
        snapshotHashes.push(result.snapshotHash);
      }

      if (result.outcome === "block") {
        blocked = true;
        final = result;
        break;
      }
    }

    if (!blocked) {
      const lastHash = snapshotHashes[snapshotHashes.length - 1];
      if (lastHash !== undefined) {
        final.snapshotHash = lastHash;
      }
    }

    safeRecord(this.reporter, {
      name: "guard.evaluate",
      durationMs: performance.now() - t0,
      // Privacy: no tool name, no tool input/output, no snapshot hash.
      // outcome is "allow"|"block" — a categorical aggregate, not user data.
      attrs: {
        outcome: final.outcome,
        guards: this.guards.length,
      },
    });

    return final;
  }

  get size(): number {
    return this.guards.length;
  }
}
