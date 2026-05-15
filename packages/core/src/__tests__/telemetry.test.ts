import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repository } from "../repository.js";
import { ConsoleReporter } from "../telemetry/console-reporter.js";
import { buildReporter } from "../telemetry/index.js";
import type { Reporter, Span } from "../telemetry/reporter.js";

class CapturingReporter implements Reporter {
  spans: Span[] = [];
  recordSpan(span: Span): void {
    this.spans.push(span);
  }
}

let tmpDir: string;
let openRepos: Repository[] = [];

beforeEach(() => {
  tmpDir = join(tmpdir(), `agentgit-telemetry-${crypto.randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  openRepos = [];
});

afterEach(() => {
  for (const repo of openRepos) repo.index.close();
  openRepos = [];
  rmSync(tmpDir, { recursive: true, force: true });
});

function openRepo(): Repository {
  const repo = Repository.init(tmpDir);
  openRepos.push(repo);
  return repo;
}

describe("telemetry", () => {
  it("buildReporter returns null when telemetry is disabled (default)", () => {
    expect(buildReporter({})).toBeNull();
    expect(buildReporter({ telemetry: { enabled: false } })).toBeNull();
  });

  it("buildReporter returns ConsoleReporter when enabled without a reporter", () => {
    const reporter = buildReporter({ telemetry: { enabled: true } });
    expect(reporter).toBeInstanceOf(ConsoleReporter);
  });

  it("Repository emits no spans when telemetry is disabled", () => {
    const repo = openRepo();
    expect(repo.reporter).toBeNull();
    const session = repo.createSession("s");
    repo.commit({
      sessionId: session.id,
      message: "hi",
      stateEntries: [{ path: "a.txt", content: "hello" }],
    });
    // No assertion needed — the absence of a reporter means no span paths run.
  });

  it("Repository emits commit, objectstore.write, and index.transaction spans when enabled", () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ telemetry: { enabled: true } }),
    );
    const repo = openRepo();
    expect(repo.reporter).not.toBeNull();

    // Replace the auto-built ConsoleReporter with a capturing one for assertions.
    const captured = new CapturingReporter();
    (repo as unknown as { reporter: Reporter }).reporter = captured;
    (repo.objects as unknown as { reporter: Reporter }).reporter = captured;
    (repo.index as unknown as { reporter: Reporter }).reporter = captured;

    const session = repo.createSession("s");
    repo.commit({
      sessionId: session.id,
      message: "hi",
      stateEntries: [{ path: "a.txt", content: "hello" }],
    });

    const names = captured.spans.map((s) => s.name);
    expect(names).toContain("commit");
    expect(names).toContain("objectstore.write");
    expect(names).toContain("index.transaction");
  });

  it("emitted span attrs never leak user-supplied data", () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ telemetry: { enabled: true } }),
    );
    const repo = openRepo();
    const captured = new CapturingReporter();
    (repo as unknown as { reporter: Reporter }).reporter = captured;
    (repo.objects as unknown as { reporter: Reporter }).reporter = captured;
    (repo.index as unknown as { reporter: Reporter }).reporter = captured;

    const session = repo.createSession("private-session-name");
    repo.commit({
      sessionId: session.id,
      message: "secret commit message — do not leak",
      stateEntries: [{ path: "secrets.txt", content: "API_KEY=hunter2" }],
    });

    // The privacy contract: attrs must be counts/booleans/categorical only.
    const forbidden = [
      session.id,
      "private-session-name",
      "secret commit message",
      "secrets.txt",
      "API_KEY",
      "hunter2",
    ];
    for (const span of captured.spans) {
      const attrJson = JSON.stringify(span.attrs ?? {});
      for (const needle of forbidden) {
        expect(attrJson).not.toContain(needle);
      }
      // Attribute values must be primitive (no nested objects with paths/etc.).
      for (const value of Object.values(span.attrs ?? {})) {
        expect(["number", "boolean", "string", "undefined"]).toContain(
          typeof value,
        );
      }
    }
  });
});
