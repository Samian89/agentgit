import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Light-weight assertion that the bench harness exports the four named
// scenarios with their declared budgets. We import the harness as a value
// module so vitest never executes the bench loop (the harness only runs
// main() when invoked directly).
import {
  SCENARIOS,
  REPORT_SCHEMA,
  runForTest,
  // @ts-expect-error — JS module without types
} from "../../../../benchmarks/harness.js";

describe("benchmarks/harness", () => {
  it("exports the four required scenarios", () => {
    const names = (SCENARIOS as { NAME: string; BUDGET_MS: number }[]).map(
      (s) => s.NAME,
    );
    expect(names.sort()).toEqual(
      ["blob-1mb", "diff-large-trees", "log-10k", "ui-session-load"].sort(),
    );
  });

  it("declares the spec'd budgets", () => {
    const byName = new Map(
      (SCENARIOS as { NAME: string; BUDGET_MS: number }[]).map((s) => [
        s.NAME,
        s.BUDGET_MS,
      ]),
    );
    expect(byName.get("log-10k")).toBe(200);
    expect(byName.get("diff-large-trees")).toBe(500);
    expect(byName.get("ui-session-load")).toBe(1000);
  });

  it("publishes a stable report schema name", () => {
    expect(REPORT_SCHEMA).toBe("agentgit-bench-report/v1");
  });
});

type FakeScenario = {
  NAME: string;
  BUDGET_MS: number;
  setup: () => Promise<void>;
  run: () => Promise<number>;
  teardown: () => Promise<void>;
};

// Tiny in-memory scenarios so the test never touches the real benchmark
// modules — the real ones spin up SQLite indexes and 10k-commit fixtures.
// Each scenario's `run()` returns a constant elapsed value, so the harness's
// pass/fail decision is fully deterministic.
function makeFakeScenario(name: string, budget: number, runMs: number): FakeScenario {
  return {
    NAME: name,
    BUDGET_MS: budget,
    setup: async () => {},
    run: async () => runMs,
    teardown: async () => {},
  };
}

describe("benchmarks/harness --check exit contract", () => {
  let exitSpy: any;
  let stdoutSpy: any;
  let stderrSpy: any;

  beforeEach(() => {
    // Throw on process.exit so we (a) detect that it was called and (b) don't
    // actually kill the vitest worker. The Error message uniquely identifies
    // this stub so an unrelated throw can't be mistaken for an exit.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__test_process_exit__");
    }) as never);
    // Silence the harness's report JSON / progress lines — the test asserts
    // on the returned report object, not on stdout/stderr.
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("calls process.exit(1) when a scenario exceeds its budget under --check", async () => {
    // BUDGET_MS=1, observed runMs=50 → max > budget → passed: false.
    const violating = makeFakeScenario("fake-violate", 1, 50);
    await expect(runForTest(["--check"], [violating])).rejects.toThrow(
      "__test_process_exit__",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does NOT call process.exit when every scenario passes under --check", async () => {
    // BUDGET_MS=5000, observed runMs=1 → max <= budget → passed: true.
    const passing = makeFakeScenario("fake-pass", 5000, 1);
    const report = await runForTest(["--check"], [passing]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(report.results).toHaveLength(1);
    expect(report.results[0].passed).toBe(true);
    expect(report.results[0].name).toBe("fake-pass");
  });

  it("marks the offending scenario passed:false in the report", async () => {
    // Without --check we never reach process.exit, so we get the report back
    // and can confirm the per-scenario decision matches the exit contract.
    const violating = makeFakeScenario("fake-violate-report", 1, 50);
    const report = await runForTest([], [violating]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(report.results[0].passed).toBe(false);
    expect(report.results[0].name).toBe("fake-violate-report");
    expect(report.results[0].budgetMs).toBe(1);
    expect(report.results[0].maxMs).toBeGreaterThan(1);
  });
});
