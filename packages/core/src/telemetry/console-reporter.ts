import type { Reporter, Span } from "./reporter.js";

/**
 * Default reporter when telemetry is enabled without an `otlp` endpoint.
 * Writes a single line per span to stderr in the form:
 *   `agentgit-span name=<name> ms=<duration> attrs=<json>`
 *
 * @public
 */
export class ConsoleReporter implements Reporter {
  constructor(private readonly stream: NodeJS.WritableStream = process.stderr) {}

  recordSpan(span: Span): void {
    const attrs = span.attrs ? JSON.stringify(span.attrs) : "{}";
    this.stream.write(
      `agentgit-span name=${span.name} ms=${span.durationMs.toFixed(2)} attrs=${attrs}\n`,
    );
  }
}
