export type { Reporter, Span, TelemetryConfig } from "./reporter.js";
export { safeRecord } from "./reporter.js";
export { ConsoleReporter } from "./console-reporter.js";
export { OTLPReporter } from "./otlp-reporter.js";

import type { AgentGitConfig } from "../config.js";
import { ConsoleReporter } from "./console-reporter.js";
import { OTLPReporter } from "./otlp-reporter.js";
import type { Reporter } from "./reporter.js";

/**
 * Build a Reporter from config, or return `null` when telemetry is disabled.
 *
 * Strictly opt-in: returns `null` unless `config.telemetry.enabled === true`.
 * When opt-in is on but no reporter is named, defaults to `ConsoleReporter`.
 *
 * @public
 */
export function buildReporter(config: AgentGitConfig): Reporter | null {
  const t = config.telemetry;
  if (!t || t.enabled !== true) return null;
  const reporter = t.reporter ?? "console";
  if (reporter === "otlp") {
    if (!t.endpoint) {
      // Misconfigured opt-in: fall back to console rather than throwing,
      // so user agents never crash because of a typo in telemetry config.
      return new ConsoleReporter();
    }
    return new OTLPReporter(t.endpoint, t.serviceName);
  }
  return new ConsoleReporter();
}
