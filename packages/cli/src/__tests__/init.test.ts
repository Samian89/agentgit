import { existsSync, readFileSync } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCommand } from "../commands/init.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `agentgit-cli-test-${crypto.randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("initCommand", () => {
  it("creates .agentgit/ directory", () => {
    initCommand(testDir);
    expect(existsSync(join(testDir, ".agentgit"))).toBe(true);
  });

  it("creates objects/ subdirectory", () => {
    initCommand(testDir);
    expect(existsSync(join(testDir, ".agentgit", "objects"))).toBe(true);
  });

  it("creates refs/ subdirectory", () => {
    initCommand(testDir);
    expect(existsSync(join(testDir, ".agentgit", "refs"))).toBe(true);
  });

  it("creates index.db", () => {
    initCommand(testDir);
    expect(existsSync(join(testDir, ".agentgit", "index.db"))).toBe(true);
  });

  it("creates HEAD file with default symbolic ref", () => {
    initCommand(testDir);
    const headPath = join(testDir, ".agentgit", "HEAD");
    expect(existsSync(headPath)).toBe(true);
    expect(readFileSync(headPath, "utf8").trim()).toBe("ref: refs/sessions/main");
  });

  it("is idempotent — calling twice does not throw", () => {
    initCommand(testDir);
    expect(() => initCommand(testDir)).not.toThrow();
  });
});
