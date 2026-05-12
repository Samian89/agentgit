import { existsSync, readFileSync } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repository } from "@agentgit/core";
import { checkoutCommand } from "../commands/checkout.js";
import type { CheckoutSnapshot } from "../commands/checkout.js";

let testDir: string;
let agentgitDir: string;
let repo: Repository;

beforeEach(() => {
  testDir = join(tmpdir(), `agentgit-cli-test-${crypto.randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  agentgitDir = join(testDir, ".agentgit");
  repo = Repository.init(agentgitDir);
});

afterEach(() => {
  repo.index.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("checkoutCommand", () => {
  it("writes .agentgit/CHECKOUT file", () => {
    const session = repo.createSession("checkout-test");
    const commit = repo.commit({
      sessionId: session.id,
      message: "add files",
      stateEntries: [{ path: "README.md", content: "# Hello" }],
    });
    repo.index.close();

    vi.spyOn(console, "log").mockImplementation(() => {});
    checkoutCommand(agentgitDir, commit.hash);
    vi.restoreAllMocks();

    expect(existsSync(join(agentgitDir, "CHECKOUT"))).toBe(true);

    repo = Repository.open(agentgitDir);
  });

  it("CHECKOUT file contains valid snapshot JSON", () => {
    const session = repo.createSession("checkout-test");
    const commit = repo.commit({
      sessionId: session.id,
      message: "snapshot step",
      stateEntries: [{ path: "agent.py", content: "x = 1" }],
    });
    repo.index.close();

    vi.spyOn(console, "log").mockImplementation(() => {});
    checkoutCommand(agentgitDir, commit.hash);
    vi.restoreAllMocks();

    const raw = readFileSync(join(agentgitDir, "CHECKOUT"), "utf-8");
    const snapshot: CheckoutSnapshot = JSON.parse(raw);

    expect(snapshot.commitHash).toBe(commit.hash);
    expect(snapshot.message).toBe("snapshot step");
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]?.path).toBe("agent.py");
    expect(snapshot.files[0]?.content).toBe("x = 1");

    repo = Repository.open(agentgitDir);
  });
});
