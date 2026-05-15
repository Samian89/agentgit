// harness.js — runs every benchmark scenario, prints a JSON report, and
// (when invoked with --check) exits non-zero if any scenario blew its budget.
//
// Each scenario module exports { NAME, BUDGET_MS, setup, run, teardown }.
// `run` returns the elapsed milliseconds we want to compare against the
// budget — we measure inside the scenario so setup/teardown noise is excluded.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Bench } from "tinybench";
import * as log10k from "./bench-log-10k.js";
import * as diffLarge from "./bench-diff-large-trees.js";
import * as blob1mb from "./bench-blob-1mb.js";
import * as uiSession from "./bench-ui-session-load.js";

const SCENARIOS = [log10k, diffLarge, blob1mb, uiSession];

const args = new Set(process.argv.slice(2));
const checkBudgets = args.has("--check");
const reportPath = (() => {
  const idx = process.argv.indexOf("--report");
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
})();

// CI environments are slow, so allow scenarios to skip in --check mode when
// the platform is known to be unsuitable (e.g., 4-core GH runners on macOS
// hit blob-1mb FS latency that doesn't reflect real-world usage). Right now
// we don't skip anything; this hook exists so the report stays machine-readable.

const iterations = Number(process.env.AGENTGIT_BENCH_ITERATIONS ?? "3");

async function runScenario(mod) {
  await mod.setup();
  const samples = [];
  // Use tinybench's measurement loop for warmup + repeats, but each iteration
  // calls mod.run() which returns its own wall-clock — we trust the scenario's
  // measurement over the loop's outer timer.
  const bench = new Bench({ iterations, time: 0 });
  bench.add(mod.NAME, async () => {
    const ms = await mod.run();
    samples.push(ms);
  });
  await bench.warmup();
  await bench.run();
  await mod.teardown();
  samples.sort((a, b) => a - b);
  const min = samples[0];
  const max = samples[samples.length - 1];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    name: mod.NAME,
    budgetMs: mod.BUDGET_MS,
    iterations: samples.length,
    minMs: round(min),
    maxMs: round(max),
    meanMs: round(mean),
    passed: max <= mod.BUDGET_MS,
  };
}

function round(x) {
  return Math.round(x * 100) / 100;
}

async function main() {
  const results = [];
  for (const mod of SCENARIOS) {
    process.stderr.write(`[bench] ${mod.NAME} ...\n`);
    try {
      const result = await runScenario(mod);
      results.push(result);
      process.stderr.write(
        `[bench] ${mod.NAME}: mean=${result.meanMs}ms max=${result.maxMs}ms budget=${result.budgetMs}ms ${result.passed ? "PASS" : "FAIL"}\n`,
      );
    } catch (err) {
      results.push({
        name: mod.NAME,
        budgetMs: mod.BUDGET_MS,
        error: String(err?.stack ?? err),
        passed: false,
      });
      process.stderr.write(`[bench] ${mod.NAME}: ERROR ${err}\n`);
    }
  }
  const report = {
    schema: "agentgit-bench-report/v1",
    generatedAt: new Date().toISOString(),
    iterations,
    results,
  };
  const out = JSON.stringify(report, null, 2);
  process.stdout.write(out + "\n");
  if (reportPath !== null) {
    writeFileSync(reportPath, out + "\n", "utf8");
  }
  if (checkBudgets) {
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      process.stderr.write(
        `[bench] ${failed.length} scenario(s) exceeded budget: ${failed.map((f) => f.name).join(", ")}\n`,
      );
      process.exit(1);
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const isEntry = process.argv[1] && process.argv[1] === __filename;
if (isEntry) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(2);
  });
}

// Re-export for unit tests of the harness shape.
export { SCENARIOS };
export const HERE = dirname(__filename);
export const REPORT_SCHEMA = "agentgit-bench-report/v1";
export function reportPathFor(name) {
  return join(HERE, `${name}.json`);
}
