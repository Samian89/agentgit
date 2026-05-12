import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repository } from "@agentgit/core";
import { exportCommand } from "../commands/export.js";
import type { ReplayExport } from "../types.js";

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

describe("exportCommand", () => {
  it("emits valid JSON to stdout matching ReplayExport schema", () => {
    const session = repo.createSession("export-session");
    const tc = {
      id: "tc1",
      name: "writeFile",
      input: { path: "/tmp/out.txt", content: "done" },
      output: null,
      startedAt: Date.now(),
      completedAt: null,
      status: "pending" as const,
      error: null,
    };
    repo.commit({
      sessionId: session.id,
      message: "write output",
      toolCall: tc,
      stateEntries: [{ path: "out.txt", content: "done" }],
    });
    repo.index.close();

    let captured = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      captured += String(chunk);
      return true;
    });

    exportCommand(agentgitDir, session.name);
    vi.restoreAllMocks();

    const payload: ReplayExport = JSON.parse(captured);
    expect(payload.version).toBe("1");
    expect(payload.sessionId).toBe(session.id);
    expect(payload.sessionName).toBe("export-session");
    expect(payload.commits).toHaveLength(1);
    expect(payload.commits[0]?.message).toBe("write output");
    expect(payload.commits[0]?.toolCall?.name).toBe("writeFile");
    expect(payload.commits[0]?.stateSnapshot).toHaveLength(1);
    expect(payload.commits[0]?.stateSnapshot[0]?.path).toBe("out.txt");

    repo = Repository.open(agentgitDir);
  });
});
