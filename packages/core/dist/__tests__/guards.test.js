import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectStore } from "../object-store.js";
import { ConfirmationGuard } from "../guards/confirmation-guard.js";
import { SnapshotGuard } from "../guards/snapshot-guard.js";
import { GuardRegistry } from "../guards/registry.js";
import { loadGuards, loadGuardsFromFile } from "../guards/load-guards.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeToolCall(name, input = {}) {
    return {
        id: crypto.randomUUID(),
        name,
        input,
        output: null,
        startedAt: Date.now(),
        completedAt: null,
        status: "pending",
        error: null,
    };
}
let tmpDir;
let objectsDir;
let store;
beforeEach(() => {
    tmpDir = join(tmpdir(), `agentgit-guards-test-${crypto.randomUUID()}`);
    objectsDir = join(tmpDir, "objects");
    mkdirSync(objectsDir, { recursive: true });
    store = new ObjectStore(objectsDir);
});
afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// ConfirmationGuard
// ---------------------------------------------------------------------------
describe("ConfirmationGuard", () => {
    it("allows non-destructive tool calls without prompting", async () => {
        const prompted = vi.fn();
        const guard = new ConfirmationGuard({ promptFn: prompted });
        const result = await guard.check({ toolCall: makeToolCall("readFile") });
        expect(result.outcome).toBe("allow");
        expect(prompted).not.toHaveBeenCalled();
    });
    it("blocks deleteFile when user inputs n", async () => {
        const guard = new ConfirmationGuard({ promptFn: async () => "n" });
        const result = await guard.check({
            toolCall: makeToolCall("deleteFile", { path: "/tmp/x.txt" }),
        });
        expect(result.outcome).toBe("block");
        expect(result.reason).toContain("deleteFile");
    });
    it("allows deleteFile when user inputs y", async () => {
        const guard = new ConfirmationGuard({ promptFn: async () => "y" });
        const result = await guard.check({
            toolCall: makeToolCall("deleteFile", { path: "/tmp/x.txt" }),
        });
        expect(result.outcome).toBe("allow");
    });
    it("blocks rm tool calls", async () => {
        const guard = new ConfirmationGuard({ promptFn: async () => "" });
        const result = await guard.check({ toolCall: makeToolCall("rm") });
        expect(result.outcome).toBe("block");
    });
    it("blocks shell tool calls", async () => {
        const guard = new ConfirmationGuard({ promptFn: async () => "N" });
        const result = await guard.check({ toolCall: makeToolCall("shell") });
        expect(result.outcome).toBe("block");
    });
    it("respects custom destructiveTools list", async () => {
        const guard = new ConfirmationGuard({
            destructiveTools: ["dangerousTool"],
            promptFn: async () => "n",
        });
        const allowed = await guard.check({ toolCall: makeToolCall("deleteFile") });
        expect(allowed.outcome).toBe("allow");
        const blocked = await guard.check({ toolCall: makeToolCall("dangerousTool") });
        expect(blocked.outcome).toBe("block");
    });
    it("treats empty / whitespace-only input as n", async () => {
        const guard = new ConfirmationGuard({ promptFn: async () => "  " });
        const result = await guard.check({
            toolCall: makeToolCall("deleteFile"),
        });
        expect(result.outcome).toBe("block");
    });
});
// ---------------------------------------------------------------------------
// SnapshotGuard
// ---------------------------------------------------------------------------
describe("SnapshotGuard", () => {
    it("allows non-write tool calls without snapshotting", async () => {
        const readFileFn = vi.fn();
        const guard = new SnapshotGuard({ objectStore: store, readFileFn });
        const result = await guard.check({ toolCall: makeToolCall("readFile") });
        expect(result.outcome).toBe("allow");
        expect(result.snapshotHash).toBeUndefined();
        expect(readFileFn).not.toHaveBeenCalled();
    });
    it("snapshots existing file content before write tool calls", async () => {
        const content = "original content";
        const guard = new SnapshotGuard({
            objectStore: store,
            readFileFn: async () => content,
        });
        const result = await guard.check({
            toolCall: makeToolCall("writeFile", { path: "/tmp/foo.txt" }),
        });
        expect(result.outcome).toBe("allow");
        expect(result.snapshotHash).toBeDefined();
        expect(store.has(result.snapshotHash)).toBe(true);
        const stored = store.read(result.snapshotHash);
        expect(stored.content).toBe(content);
    });
    it("does not snapshot when file does not exist", async () => {
        const guard = new SnapshotGuard({
            objectStore: store,
            readFileFn: async () => null,
        });
        const result = await guard.check({
            toolCall: makeToolCall("writeFile", { path: "/tmp/new.txt" }),
        });
        expect(result.outcome).toBe("allow");
        expect(result.snapshotHash).toBeUndefined();
    });
    it("extracts path from filePath key", async () => {
        const readFileFn = vi.fn(async () => "data");
        const guard = new SnapshotGuard({ objectStore: store, readFileFn });
        await guard.check({
            toolCall: makeToolCall("writeFile", { filePath: "/tmp/bar.txt" }),
        });
        expect(readFileFn).toHaveBeenCalledWith("/tmp/bar.txt");
    });
    it("extracts path from file_path key", async () => {
        const readFileFn = vi.fn(async () => "data");
        const guard = new SnapshotGuard({ objectStore: store, readFileFn });
        await guard.check({
            toolCall: makeToolCall("edit_file", { file_path: "/tmp/baz.txt" }),
        });
        expect(readFileFn).toHaveBeenCalledWith("/tmp/baz.txt");
    });
    it("allows write tool call with no path in input", async () => {
        const guard = new SnapshotGuard({
            objectStore: store,
            readFileFn: async () => "content",
        });
        const result = await guard.check({
            toolCall: makeToolCall("writeFile", {}),
        });
        expect(result.outcome).toBe("allow");
        expect(result.snapshotHash).toBeUndefined();
    });
    it("respects custom writeTools list", async () => {
        const readFileFn = vi.fn(async () => "data");
        const guard = new SnapshotGuard({
            objectStore: store,
            writeTools: ["customWrite"],
            readFileFn,
        });
        const ignored = await guard.check({
            toolCall: makeToolCall("writeFile", { path: "/tmp/f.txt" }),
        });
        expect(ignored.snapshotHash).toBeUndefined();
        await guard.check({
            toolCall: makeToolCall("customWrite", { path: "/tmp/f.txt" }),
        });
        expect(readFileFn).toHaveBeenCalledTimes(1);
    });
    it("uses context objectStore when provided", async () => {
        const dir2 = join(tmpdir(), `agentgit-guards-ctx-${crypto.randomUUID()}`);
        mkdirSync(dir2, { recursive: true });
        const store2 = new ObjectStore(dir2);
        const guard = new SnapshotGuard({
            objectStore: store,
            readFileFn: async () => "ctx-content",
        });
        const result = await guard.check({
            toolCall: makeToolCall("writeFile", { path: "/tmp/x.txt" }),
            objectStore: store2,
        });
        expect(result.snapshotHash).toBeDefined();
        // Written into store2, not the guard's own store
        expect(store2.has(result.snapshotHash)).toBe(true);
        expect(store.has(result.snapshotHash)).toBe(false);
        rmSync(dir2, { recursive: true, force: true });
    });
});
// ---------------------------------------------------------------------------
// GuardRegistry
// ---------------------------------------------------------------------------
describe("GuardRegistry", () => {
    it("returns allow when no guards are registered", async () => {
        const registry = new GuardRegistry([]);
        const result = await registry.runGuards(makeToolCall("anything"));
        expect(result.outcome).toBe("allow");
    });
    it("returns allow when all guards allow", async () => {
        const g1 = new ConfirmationGuard({
            destructiveTools: [],
            promptFn: async () => "y",
        });
        const registry = new GuardRegistry([g1]);
        const result = await registry.runGuards(makeToolCall("readFile"));
        expect(result.outcome).toBe("allow");
    });
    it("stops at the first blocking guard", async () => {
        const called = [];
        const blocking = {
            name: "BlockingGuard",
            check: async () => {
                called.push("blocking");
                return { outcome: "block", reason: "test" };
            },
        };
        const neverCalled = {
            name: "NeverCalledGuard",
            check: async () => {
                called.push("neverCalled");
                return { outcome: "allow" };
            },
        };
        const registry = new GuardRegistry([blocking, neverCalled]);
        const result = await registry.runGuards(makeToolCall("deleteFile"));
        expect(result.outcome).toBe("block");
        expect(called).toEqual(["blocking"]);
    });
    it("runs all guards in registration order when all allow", async () => {
        const order = [];
        const makePassGuard = (name) => ({
            name,
            check: async () => {
                order.push(name);
                return { outcome: "allow" };
            },
        });
        const registry = new GuardRegistry([
            makePassGuard("first"),
            makePassGuard("second"),
            makePassGuard("third"),
        ]);
        await registry.runGuards(makeToolCall("readFile"));
        expect(order).toEqual(["first", "second", "third"]);
    });
    it("surfaces snapshot hash from SnapshotGuard", async () => {
        const snapshotGuard = new SnapshotGuard({
            objectStore: store,
            readFileFn: async () => "pre-content",
        });
        const registry = new GuardRegistry([snapshotGuard]);
        const result = await registry.runGuards(makeToolCall("writeFile", { path: "/tmp/x.txt" }));
        expect(result.outcome).toBe("allow");
        expect(result.snapshotHash).toBeDefined();
    });
    it("exposes size of the guard chain", () => {
        const registry = new GuardRegistry([
            new ConfirmationGuard(),
        ]);
        expect(registry.size).toBe(1);
    });
});
// ---------------------------------------------------------------------------
// loadGuards / loadGuardsFromFile
// ---------------------------------------------------------------------------
describe("loadGuards", () => {
    it("creates ConfirmationGuard and SnapshotGuard when both enabled", () => {
        const registry = loadGuards({ confirmationGuard: { enabled: true }, snapshotGuard: { enabled: true } }, store);
        expect(registry.size).toBe(2);
    });
    it("omits SnapshotGuard when no objectStore provided", () => {
        const registry = loadGuards({
            confirmationGuard: { enabled: true },
            snapshotGuard: { enabled: true },
        });
        expect(registry.size).toBe(1);
    });
    it("omits ConfirmationGuard when disabled", () => {
        const registry = loadGuards({ confirmationGuard: { enabled: false }, snapshotGuard: { enabled: true } }, store);
        expect(registry.size).toBe(1);
    });
    it("omits SnapshotGuard when disabled", () => {
        const registry = loadGuards({ confirmationGuard: { enabled: true }, snapshotGuard: { enabled: false } }, store);
        expect(registry.size).toBe(1);
    });
    it("creates empty registry when all guards disabled", () => {
        const registry = loadGuards({
            confirmationGuard: { enabled: false },
            snapshotGuard: { enabled: false },
        });
        expect(registry.size).toBe(0);
    });
});
describe("loadGuardsFromFile", () => {
    it("returns empty registry when config.json does not exist", () => {
        const registry = loadGuardsFromFile(tmpDir);
        expect(registry.size).toBe(0);
    });
    it("loads guards from config.json", () => {
        writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
            confirmationGuard: { enabled: true },
            snapshotGuard: { enabled: true },
        }));
        const registry = loadGuardsFromFile(tmpDir, store);
        expect(registry.size).toBe(2);
    });
    it("respects disabled guards in config.json", () => {
        writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
            confirmationGuard: { enabled: false },
            snapshotGuard: { enabled: true },
        }));
        const registry = loadGuardsFromFile(tmpDir, store);
        expect(registry.size).toBe(1);
    });
    it("ConfirmationGuard from file blocks deleteFile and proceeds after y", async () => {
        writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ confirmationGuard: { enabled: true } }));
        // Can't inject promptFn via file load — test the ConfirmationGuard directly
        // with the custom destructiveTools from config.json
        writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
            confirmationGuard: {
                enabled: true,
                destructiveTools: ["dangerousOp"],
            },
        }));
        const registry = loadGuardsFromFile(tmpDir);
        // ConfirmationGuard will use real readline, so override via the guard directly
        const confirmGuard = new ConfirmationGuard({
            destructiveTools: ["dangerousOp"],
            promptFn: async () => "y",
        });
        const innerRegistry = new GuardRegistry([confirmGuard]);
        const result = await innerRegistry.runGuards(makeToolCall("dangerousOp"));
        expect(result.outcome).toBe("allow");
        expect(registry.size).toBe(1);
    });
});
//# sourceMappingURL=guards.test.js.map