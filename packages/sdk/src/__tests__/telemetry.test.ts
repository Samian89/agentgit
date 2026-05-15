import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapAgentJS } from "../index.js";

/**
 * End-to-end telemetry coverage for the wrapped-agent path.
 *
 * Spec acceptance: "With telemetry.enabled=true and the console reporter,
 * wrapping an agent emits at least one commit, one guard.evaluate, and one
 * objectstore.write span to stderr. With telemetry.enabled=false (default),
 * no spans are emitted; the reporter is never instantiated."
 *
 * This file owns the SDK surface so guard.evaluate (which only fires inside
 * GuardRegistry.runGuards, called from the SDK wrapper around every tool
 * call) is exercised. Lower-level core tests cover Repository.commit and
 * ObjectStore directly.
 */

class DemoAgent {
  async run(prompt: string): Promise<string> {
    await this.search({ query: prompt });
    return "ok";
  }
  async search(_input: { query: string }): Promise<string> {
    return "hit";
  }
}

/**
 * Tap process.stderr.write while fn runs, collecting every chunk written.
 * Both the spec acceptance check and the privacy stance hinge on the
 * default `ConsoleReporter` actually reaching stderr, so we observe that
 * channel directly rather than reaching inside the GuardRegistry.
 */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{
  result: T;
  chunks: string[];
}> {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  // process.stderr.write has overloads — wrap with a permissive shim.
  (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write =
    (chunk: unknown, ...rest: unknown[]): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, prefer-spread
      return (originalWrite as any).apply(process.stderr, [chunk, ...rest]);
    };
  try {
    const result = await fn();
    return { result, chunks };
  } finally {
    (process.stderr as unknown as { write: typeof originalWrite }).write =
      originalWrite;
  }
}

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentgit-sdk-telemetry-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SDK telemetry", () => {
  it("emits commit + guard.evaluate + objectstore.write to stderr when enabled", async () => {
    const repoDir = join(tmpDir, ".agentgit");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      join(repoDir, "config.json"),
      JSON.stringify({
        telemetry: { enabled: true },
        // Disable default destructive-tool prompts so guard.evaluate runs
        // through cleanly under headless test conditions.
        guards: { confirmation: { destructiveTools: [] } },
      }),
    );

    const { chunks } = await captureStderr(async () => {
      const wrapped = wrapAgentJS(new DemoAgent(), { repoDir });
      await wrapped.run("hello world");
      wrapped.agentgit.end();
      wrapped.agentgit.repo.index.close();
    });

    const joined = chunks.join("");
    // ConsoleReporter writes one line per span: `agentgit-span name=<name> ...`.
    expect(joined).toMatch(/agentgit-span name=commit /);
    expect(joined).toMatch(/agentgit-span name=guard\.evaluate /);
    expect(joined).toMatch(/agentgit-span name=objectstore\.write /);
  });

  it("emits no spans and never instantiates a reporter when disabled (default)", async () => {
    const repoDir = join(tmpDir, ".agentgit");
    mkdirSync(repoDir, { recursive: true });
    // No config file => telemetry off (default).

    const { chunks } = await captureStderr(async () => {
      const wrapped = wrapAgentJS(new DemoAgent(), { repoDir });
      // Acceptance criterion: reporter is never instantiated.
      expect(wrapped.agentgit.repo.reporter).toBeNull();
      await wrapped.run("hello");
      wrapped.agentgit.end();
      wrapped.agentgit.repo.index.close();
    });

    const joined = chunks.join("");
    expect(joined).not.toMatch(/agentgit-span/);
  });
});
