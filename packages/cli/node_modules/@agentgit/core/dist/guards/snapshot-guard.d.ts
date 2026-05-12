import type { ObjectStore } from "../object-store.js";
import type { Guard, GuardContext, GuardResult, ReadFileFn } from "./types.js";
export interface SnapshotGuardOptions {
    objectStore: ObjectStore;
    writeTools?: string[];
    /** Injectable file reader — defaults to fs.readFile. */
    readFileFn?: ReadFileFn;
}
export declare class SnapshotGuard implements Guard {
    readonly name = "SnapshotGuard";
    private readonly objectStore;
    private readonly writeTools;
    private readonly readFileFn;
    constructor(options: SnapshotGuardOptions);
    check(context: GuardContext): Promise<GuardResult>;
}
//# sourceMappingURL=snapshot-guard.d.ts.map