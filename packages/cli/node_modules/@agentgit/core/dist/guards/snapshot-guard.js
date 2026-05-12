import { readFile } from "node:fs/promises";
const DEFAULT_WRITE_TOOLS = [
    "writeFile",
    "write_file",
    "editFile",
    "edit_file",
    "createFile",
    "create_file",
];
export class SnapshotGuard {
    name = "SnapshotGuard";
    objectStore;
    writeTools;
    readFileFn;
    constructor(options) {
        this.objectStore = options.objectStore;
        this.writeTools = new Set(options.writeTools ?? DEFAULT_WRITE_TOOLS);
        this.readFileFn = options.readFileFn ?? defaultReadFile;
    }
    async check(context) {
        const { toolCall, objectStore } = context;
        const store = objectStore ?? this.objectStore;
        if (!this.writeTools.has(toolCall.name)) {
            return { outcome: "allow" };
        }
        const filePath = extractFilePath(toolCall.input);
        if (!filePath) {
            return { outcome: "allow" };
        }
        const content = await this.readFileFn(filePath);
        if (content === null) {
            // File does not exist yet — nothing to snapshot.
            return { outcome: "allow" };
        }
        const snapshotHash = store.write({
            type: "blob",
            content,
            size: Buffer.byteLength(content, "utf-8"),
            encoding: "utf-8",
            mimeType: null,
        });
        return { outcome: "allow", snapshotHash };
    }
}
function extractFilePath(input) {
    for (const key of ["path", "filePath", "file_path", "filename"]) {
        const val = input[key];
        if (typeof val === "string") {
            return val;
        }
    }
    return null;
}
async function defaultReadFile(filePath) {
    try {
        return await readFile(filePath, "utf-8");
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=snapshot-guard.js.map