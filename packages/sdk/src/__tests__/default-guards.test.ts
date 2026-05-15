import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Guard, GuardContext, GuardResult } from "@agentgit/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapAgentJS } from "../index.js";

// ---------------------------------------------------------------------------
// Test agent: exposes a `bash` method whose name matches DEFAULT_DESTRUCTIVE_TOOLS
// ---------------------------------------------------------------------------

class BashAgent {
  readonly calls: string[] = [];

  async run(prompt: string): Promise<string> {
    return `ran:${prompt}`;
  }

  async bash(cmd: string): Promise<string> {
    this.calls.push(cmd);
    return `executed: ${cmd}`;
  }

  async writeFile(path: string, content: string): Promise<string> {
    this.calls.push(`write:${path}`);
    return `wrote ${path}:${content}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let repoDir: string;
let closeables: Array<{ index: { close(): void } }>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentgit-default-guards-"));
  repoDir = join(tmpDir, ".agentgit");
  closeables = [];
});

afterEach(() => {
  for (const c of closeables) {
    try {
      c.index.close();
    } catch {
      /* ignore */
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Default-on behavior
// ---------------------------------------------------------------------------

describe("wrapAgentJS default guards", () => {
  it("blocks a naive bash 'rm -rf' call when no options are provided", async () => {
    // vitest runs without a TTY, so the default prompt resolves to "n" and
    // the ConfirmationGuard blocks the destructive bash call.
    const agent = new BashAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir });
    closeables.push(wrapped.agentgit.repo);

    await expect(wrapped.bash("rm -rf /tmp/x")).rejects.toThrow(
      /blocked by guard/,
    );
    expect(agent.calls).toHaveLength(0);
  });

  it("allows non-destructive tool calls even when guards are default-on", async () => {
    const agent = new BashAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir });
    closeables.push(wrapped.agentgit.repo);

    // writeFile -> not in destructive list, snapshot guard tries to read
    //  "out.txt" from cwd, comes back null -> allow.
    const result = await wrapped.writeFile("out.txt", "hi");
    expect(result).toBe("wrote out.txt:hi");
  });

  it("opt-out via { guards: false } applies no guards", async () => {
    const agent = new BashAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir, guards: false });
    closeables.push(wrapped.agentgit.repo);

    const result = await wrapped.bash("rm -rf /tmp/x");
    expect(result).toBe("executed: rm -rf /tmp/x");
    expect(agent.calls).toEqual(["rm -rf /tmp/x"]);
  });

  it("explicit array applies exactly the provided guards", async () => {
    const seen: string[] = [];
    const trackingGuard: Guard = {
      name: "tracker",
      async check(ctx: GuardContext): Promise<GuardResult> {
        seen.push(ctx.toolCall.name);
        return { outcome: "allow" };
      },
    };

    const agent = new BashAgent();
    const wrapped = await wrapAgentJS(agent, {
      repoDir,
      guards: [trackingGuard],
    });
    closeables.push(wrapped.agentgit.repo);

    // ConfirmationGuard is NOT applied, so bash succeeds despite being
    // destructive. The tracking guard sees the call.
    await wrapped.bash("ls");
    expect(seen).toEqual(["bash"]);
    expect(agent.calls).toEqual(["ls"]);
  });
});

// ---------------------------------------------------------------------------
// Config-driven overrides
// ---------------------------------------------------------------------------

describe("wrapAgentJS guards from .agentgit/config.json", () => {
  it("autoConfirm entry suppresses the prompt for that tool", async () => {
    // The agent is wrapped with no options, so it picks up defaults from
    // config.json. autoConfirm: ["bash"] means bash is destructive but
    // auto-confirmed — no prompt, no block.
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        guards: {
          confirmation: { autoConfirm: ["bash"] },
        },
      }),
    );

    const agent = new BashAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir: tmpDir });
    closeables.push(wrapped.agentgit.repo);

    const result = await wrapped.bash("ls -la");
    expect(result).toBe("executed: ls -la");
  });

  it("denylist substring hard-blocks matching input", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        guards: {
          confirmation: { denylist: ["rm -rf"] },
        },
      }),
    );

    const agent = new BashAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir: tmpDir });
    closeables.push(wrapped.agentgit.repo);

    await expect(wrapped.bash("rm -rf /tmp/x")).rejects.toThrow(
      /denylist/,
    );
  });

  it("guards.enabled = false turns off the default chain entirely", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ guards: { enabled: false } }),
    );

    const agent = new BashAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir: tmpDir });
    closeables.push(wrapped.agentgit.repo);

    // bash is destructive but the entire guard chain is disabled.
    const result = await wrapped.bash("rm -rf /tmp/x");
    expect(result).toBe("executed: rm -rf /tmp/x");
  });
});
