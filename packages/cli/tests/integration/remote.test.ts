import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@agentgit/core";
import { initCommand } from "../../src/commands/init.js";
import {
  remoteAddCommand,
  remoteListCommand,
  remoteRemoveCommand,
  getRemote,
} from "../../src/commands/remote.js";

let tmpDir: string;
let agentgitDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentgit-cli-remote-"));
  agentgitDir = join(tmpDir, ".agentgit");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("agentgit remote add/list/remove", () => {
  it("persists a remote to config.json and reads it back", () => {
    initCommand(tmpDir);
    expect(
      remoteAddCommand(agentgitDir, "origin", "https://example.com", {
        token: "secret-token",
      }),
    ).toBe(0);

    const cfg = loadConfig(agentgitDir) as {
      remotes?: Record<string, { url: string; token?: string }>;
    };
    expect(cfg.remotes).toEqual({
      origin: { url: "https://example.com", token: "secret-token" },
    });

    const r = getRemote(agentgitDir, "origin");
    expect(r).toEqual({ url: "https://example.com", token: "secret-token" });
  });

  it("rejects an invalid remote name and a non-http URL", () => {
    initCommand(tmpDir);
    expect(remoteAddCommand(agentgitDir, "bad name", "https://x", {})).toBe(1);
    expect(remoteAddCommand(agentgitDir, "origin", "ftp://x", {})).toBe(1);
  });

  it("refuses to overwrite an existing remote", () => {
    initCommand(tmpDir);
    remoteAddCommand(agentgitDir, "origin", "https://a", {});
    expect(remoteAddCommand(agentgitDir, "origin", "https://b", {})).toBe(1);
  });

  it("lists configured remotes (or prints empty marker)", () => {
    initCommand(tmpDir);
    const collected: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = ((
      s: string,
    ) => {
      collected.push(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(remoteListCommand(agentgitDir)).toBe(0);
      expect(collected.join("")).toMatch(/no remotes/);

      collected.length = 0;
      remoteAddCommand(agentgitDir, "team", "https://team.example/", { token: "t" });
      expect(remoteListCommand(agentgitDir)).toBe(0);
      const out = collected.join("");
      expect(out).toMatch(/team\thttps:\/\/team\.example\/ \[token\]/);
    } finally {
      (process.stdout.write as unknown) = origWrite;
    }
  });

  it("remove drops the entry from config.json", () => {
    initCommand(tmpDir);
    remoteAddCommand(agentgitDir, "origin", "https://a", {});
    expect(remoteRemoveCommand(agentgitDir, "origin")).toBe(0);
    expect(getRemote(agentgitDir, "origin")).toBeNull();
    // Removing a non-existent remote is an error.
    expect(remoteRemoveCommand(agentgitDir, "nope")).toBe(1);
  });
});
