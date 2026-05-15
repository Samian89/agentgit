# Performance Benchmarks, Public API Surface, CI Matrix, Opt-in Telemetry

## Goal
Establish the engineering-ops backbone: benchmark suite with budgets enforced in CI; a curated, versioned public API surface via API Extractor; a complete CI/CD matrix (typecheck, tests, Python + LangChain adapter tests, Tauri builds across OSes, npm + PyPI publish on tag); and a pluggable opt-in telemetry/Reporter interface with a documented privacy stance.

## Context
- No perf data exists. Scaling past a few hundred commits is unverified.
- `packages/sdk/` has no `@public` / `@beta` / `@internal` annotations and no `.d.ts` rollup. Accidental surface changes ship silently.
- `.github/workflows/release.yml` exists and handles tag-driven npm publish + Tauri builds; **no PR-time CI** for typecheck / unit tests / integration tests / Python adapter tests / LangChain adapter tests exists yet.
- No telemetry hooks. Maintainers have zero visibility into whether users succeed or fail.

## Technical Approach
1. **Benchmarks (`benchmarks/`)**
   - Tinybench-based (zero-dep, Vitest-compatible).
   - Scenarios:
     - `bench-log-10k.ts` — 10k commits, measure `agentgit log` end-to-end time.
     - `bench-diff-large-trees.ts` — two commits with 100k tree entries each, measure `repo.diff`.
     - `bench-blob-1mb.ts` — 1MB blob write + read round-trip.
     - `bench-ui-session-load.ts` — measure cold session-list IPC + commits IPC time.
   - Budgets:
     - `agentgit log` < 200ms for 10k commits.
     - `agentgit diff` < 500ms for 100k entries.
     - UI session-load < 1s.
   - `pnpm bench` runs all; `pnpm bench --check` exits non-zero if any scenario exceeds its budget. CI runs `pnpm bench --check`.
2. **Public API surface (`@microsoft/api-extractor`)**
   - Add `api-extractor.json` to each public package (`@agentgit/core`, `@agentgit/sdk`, `@agentgit/cli` if it has one).
   - Annotate exports with TSDoc `@public` / `@beta` / `@internal`.
   - Produce `.d.ts` rollups + `etc/<package>.api.md` baseline files committed to the repo.
   - CI runs `api-extractor run --local` and fails the build if `.api.md` diff is non-empty without `--accept`.
   - `docs/semver-policy.md` documents the deprecation process: 2 minor versions of `@deprecated` before removal; surface only `@public` is covered by semver.
3. **CI/CD matrix (`.github/workflows/`)**
   - **`ci.yml`** triggered on PR + push to main:
     - `typecheck`: `pnpm typecheck`
     - `unit`: `pnpm test`
     - `integration`: `pnpm test:integration`
     - `python`: `pytest adapters/python adapters/langchain` (matrix: 3.10/3.11/3.12)
     - `bench`: `pnpm bench --check`
     - `api-extractor`: surface-drift check
   - Reuse `release.yml` for tag-driven publish; extend it to also publish PyPI packages for `agentgit-adapter` and `agentgit-langchain` (use `pypa/gh-action-pypi-publish` with OIDC).
   - Tauri build matrix already exists; keep.
4. **Telemetry / Reporter (`packages/core/src/telemetry/`)**
   - `Reporter` interface: `recordSpan({ name, attrs, durationMs }): void`.
   - Built-in `ConsoleReporter` (logs to stderr).
   - Optional `OTLPReporter` (lazy-loaded from `@opentelemetry/exporter-trace-otlp-http`).
   - Strictly opt-in via `.agentgit/config.json` `telemetry.enabled = false` (default). No data leaves the machine without that toggle.
   - Spans emitted: `commit`, `guard.evaluate`, `objectstore.write`, `objectstore.read`, `index.transaction`.
   - Privacy doc section in README: "AgentGit emits no telemetry by default. With `telemetry.enabled=true` the reporter you configure (console by default) receives span names + durations only; no commit content, no tool inputs/outputs."

## Acceptance Criteria
- [ ] `benchmarks/` exists with the four named scenarios; `pnpm bench` produces a report and `pnpm bench --check` enforces budgets.
- [ ] CI fails a PR that regresses `agentgit log` past 200ms / `diff` past 500ms / UI load past 1s.
- [ ] `api-extractor` runs for `@agentgit/core` and `@agentgit/sdk`; baseline `.api.md` files committed; CI fails on accidental surface change.
- [ ] `docs/semver-policy.md` exists and documents `@public` / `@beta` / `@internal` + deprecation flow.
- [ ] `.github/workflows/ci.yml` exists and runs typecheck + unit + integration + Python + bench + api-extractor jobs on PR.
- [ ] On a `v*` tag push, npm packages publish AND PyPI packages publish (validated via dry-run / `--repository testpypi` for safety).
- [ ] With `telemetry.enabled=true` and the console reporter, wrapping an agent emits at least one `commit`, one `guard.evaluate`, and one `objectstore.write` span to stderr.
- [ ] With `telemetry.enabled=false` (default), no spans are emitted; the reporter is never instantiated.
- [ ] README contains the privacy paragraph.

## Files to Touch
- benchmarks/  (create — four scenarios + harness)
- packages/core/api-extractor.json  (create)
- packages/sdk/api-extractor.json  (create)
- packages/core/etc/agentgit-core.api.md  (create — committed baseline)
- packages/sdk/etc/agentgit-sdk.api.md  (create)
- packages/*/src/**  (modify — add TSDoc @public/@beta/@internal annotations)
- docs/semver-policy.md  (create)
- .github/workflows/ci.yml  (create)
- .github/workflows/release.yml  (modify — add PyPI publish jobs)
- packages/core/src/telemetry/reporter.ts  (create)
- packages/core/src/telemetry/console-reporter.ts  (create)
- packages/core/src/telemetry/otlp-reporter.ts  (create)
- packages/core/src/repository.ts  (modify — emit spans)
- packages/core/src/object-store.ts  (modify — emit spans)
- packages/core/src/sqlite-index.ts  (modify — emit spans)
- packages/core/src/guards/registry.ts  (modify — emit spans)
- README.md  (modify — privacy paragraph)

## Test Strategy
- `pnpm bench` produces a JSON report; a small unit test asserts the report shape.
- API Extractor: add a deliberate breaking export in a fixture test, confirm CI fails.
- Telemetry: unit test asserts `Reporter.recordSpan` is called the expected number of times during a wrapped agent run with telemetry enabled, and zero times when disabled.
- CI dry-run: run `act` locally or push a draft PR and verify all jobs green on a clean branch.
