import { readFile } from "node:fs/promises";
import type { ObjectStore } from "../object-store.js";
import type { Guard, GuardContext, GuardResult, ReadFileFn } from "./types.js";

const DEFAULT_WRITE_TOOLS = [
  "writeFile",
  "write_file",
  "editFile",
  "edit_file",
  "createFile",
  "create_file",
];

export interface SnapshotGuardOptions {
  objectStore: ObjectStore;
  writeTools?: string[];
  /** Injectable file reader — defaults to fs.readFile. */
  readFileFn?: ReadFileFn;
}

export class SnapshotGuard implements Guard {
  readonly name = "SnapshotGuard";
  private readonly objectStore: ObjectStore;
  private readonly writeTools: Set<string>;
  private readonly readFileFn: ReadFileFn;

  constructor(options: SnapshotGuardOptions) {
    this.objectStore = options.objectStore;
    this.writeTools = new Set(options.writeTools ?? DEFAULT_WRITE_TOOLS);
    this.readFileFn = options.readFileFn ?? defaultReadFile;
  }

  async check(context: GuardContext): Promise<GuardResult> {
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

function extractFilePath(input: Record<string, unknown>): string | null {
  for (const key of ["path", "filePath", "file_path", "filename"]) {
    const val = input[key];
    if (typeof val === "string") {
      return val;
    }
  }
  return null;
}

async function defaultReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
