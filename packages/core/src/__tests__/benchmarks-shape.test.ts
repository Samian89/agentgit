import { describe, expect, it } from "vitest";

// Light-weight assertion that the bench harness exports the four named
// scenarios with their declared budgets. We import the harness as a value
// module so vitest never executes the bench loop (the harness only runs
// main() when invoked directly).
import {
  SCENARIOS,
  REPORT_SCHEMA,
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
