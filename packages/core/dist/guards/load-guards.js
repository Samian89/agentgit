import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfirmationGuard } from "./confirmation-guard.js";
import { SnapshotGuard } from "./snapshot-guard.js";
import { GuardRegistry } from "./registry.js";
/** Build a GuardRegistry from an explicit config object. */
export function loadGuards(config, objectStore) {
    const guards = [];
    if (config.confirmationGuard?.enabled !== false) {
        const confirmOpts = {};
        const destructiveTools = config.confirmationGuard?.destructiveTools;
        if (destructiveTools !== undefined) {
            confirmOpts.destructiveTools = destructiveTools;
        }
        guards.push(new ConfirmationGuard(confirmOpts));
    }
    if (config.snapshotGuard?.enabled !== false && objectStore !== undefined) {
        const snapshotOpts = { objectStore };
        const writeTools = config.snapshotGuard?.writeTools;
        if (writeTools !== undefined) {
            snapshotOpts.writeTools = writeTools;
        }
        guards.push(new SnapshotGuard(snapshotOpts));
    }
    return new GuardRegistry(guards);
}
/**
 * Load guards from .agentgit/config.json.
 * Returns an empty registry if the file does not exist.
 */
export function loadGuardsFromFile(agentgitDir, objectStore) {
    const configPath = join(agentgitDir, "config.json");
    if (!existsSync(configPath)) {
        return new GuardRegistry([]);
    }
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return loadGuards(config, objectStore);
}
//# sourceMappingURL=load-guards.js.map