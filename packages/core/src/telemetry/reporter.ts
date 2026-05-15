/**
 * Telemetry plumbing for AgentGit.
 *
 * AgentGit emits no telemetry by default. Telemetry is strictly opt-in via
 * `.agentgit/config.json` `telemetry.enabled = true`. When disabled, no
 * reporter is instantiated and {@link buildReporter} returns `null` so
 * emission sites can short-circuit before constructing span objects.
 *
 * **Privacy contract.** Reporters receive ONLY:
 *   - span name (one of: `commit`, `guard.evaluate`, `objectstore.write`,
 *     `objectstore.read`, `index.transaction`),
 *   - duration in milliseconds,
 *   - span-specific benign attributes (never user data or identifiers):
 *     - `commit`: `{ entries: number, signed: boolean, hasLlmCall: boolean }`
 *     - `guard.evaluate`: `{ outcome: "allow" | "block", guards: number }`
 *     - `objectstore.write`: `{ deduped: boolean }`
 *     - `objectstore.read`, `index.transaction`: no attrs (`{}`)
 *
 * Reporters MUST NOT receive: commit messages, tool names, tool inputs or
 * outputs, LLM prompts/responses, file paths, file contents, session IDs, hashes, or any other
 * user-supplied data. Built-in emission sites enforce this; custom
 * reporters that wrap third-party SDKs are responsible for not enriching
 * spans with extra fields.
 *
 * @public
 */
export interface Span {
  /** Operation name. Stable across versions. */
  name: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /**
   * Optional benign attributes (counts/booleans/categorical only). Per the
   * privacy contract above, must not contain user-supplied data or
   * identifiers.
   */
  attrs?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Sink for span events. Implementations must be non-throwing; emission sites
 * use {@link safeRecord} to swallow exceptions defensively.
 *
 * @public
 */
export interface Reporter {
  recordSpan(span: Span): void;
}

/**
 * Configuration shape consumed from `.agentgit/config.json` under the
 * `telemetry` key.
 *
 * @public
 */
export interface TelemetryConfig {
  /** Master switch. Default `false`. */
  enabled?: boolean;
  /** Reporter implementation. Default `"console"`. */
  reporter?: "console" | "otlp";
  /** OTLP endpoint (required when reporter is "otlp"). */
  endpoint?: string;
  /** Service name attribute attached to spans. */
  serviceName?: string;
}

/**
 * Wrap a reporter call so emission failures never leak into caller paths.
 *
 * @internal
 */
export function safeRecord(reporter: Reporter | null, span: Span): void {
  if (reporter === null) return;
  try {
    reporter.recordSpan(span);
  } catch {
    // Telemetry must never break the host program.
  }
}
