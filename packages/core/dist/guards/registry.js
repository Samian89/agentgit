/**
 * Runs a chain of guards against a tool call in registration order.
 * Stops at the first blocking guard; all snapshot hashes from passing guards
 * are surfaced in the final result.
 */
export class GuardRegistry {
    guards;
    constructor(guards) {
        this.guards = guards;
    }
    async runGuards(toolCall, objectStore) {
        const context = objectStore !== undefined ? { toolCall, objectStore } : { toolCall };
        const snapshotHashes = [];
        for (const guard of this.guards) {
            const result = await guard.check(context);
            if (result.snapshotHash !== undefined) {
                snapshotHashes.push(result.snapshotHash);
            }
            if (result.outcome === "block") {
                return result;
            }
        }
        const combined = { outcome: "allow" };
        const lastHash = snapshotHashes[snapshotHashes.length - 1];
        if (lastHash !== undefined) {
            combined.snapshotHash = lastHash;
        }
        return combined;
    }
    get size() {
        return this.guards.length;
    }
}
//# sourceMappingURL=registry.js.map