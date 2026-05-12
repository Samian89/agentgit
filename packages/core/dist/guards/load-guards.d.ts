import type { ObjectStore } from "../object-store.js";
import { GuardRegistry } from "./registry.js";
import type { GuardConfig } from "./types.js";
/** Build a GuardRegistry from an explicit config object. */
export declare function loadGuards(config: GuardConfig, objectStore?: ObjectStore): GuardRegistry;
/**
 * Load guards from .agentgit/config.json.
 * Returns an empty registry if the file does not exist.
 */
export declare function loadGuardsFromFile(agentgitDir: string, objectStore?: ObjectStore): GuardRegistry;
//# sourceMappingURL=load-guards.d.ts.map