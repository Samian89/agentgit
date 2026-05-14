import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configPath,
  getConfigValue,
  loadConfig,
  resolveAuthor,
  saveConfig,
  setConfigValue,
} from "../config.js";

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-config-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("loadConfig returns {} when config file is absent", () => {
    expect(loadConfig(dir)).toEqual({});
  });

  it("saveConfig + loadConfig round-trip preserves values", () => {
    const cfg = { user: { name: "Alice", email: "a@x.com" } };
    saveConfig(dir, cfg);
    expect(existsSync(configPath(dir))).toBe(true);
    expect(loadConfig(dir)).toEqual(cfg);
  });

  it("setConfigValue creates nested objects for dotted keys", () => {
    const cfg = {};
    setConfigValue(cfg, "user.name", "Alice");
    setConfigValue(cfg, "user.email", "a@x.com");
    expect(cfg).toEqual({ user: { name: "Alice", email: "a@x.com" } });
  });

  it("getConfigValue returns undefined for missing keys", () => {
    expect(getConfigValue({}, "user.name")).toBeUndefined();
  });

  it("resolveAuthor returns null when name or email is missing", () => {
    expect(resolveAuthor({})).toBeNull();
    expect(resolveAuthor({ user: { name: "Alice" } })).toBeNull();
    expect(resolveAuthor({ user: { email: "a@x.com" } })).toBeNull();
  });

  it("resolveAuthor returns the identity when both are set", () => {
    expect(
      resolveAuthor({ user: { name: "Alice", email: "a@x.com" } }),
    ).toEqual({ name: "Alice", email: "a@x.com" });
  });
});
