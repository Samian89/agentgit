// @ts-check
/**
 * LangChain ReAct example wired to AgentGit.
 *
 * The LLM is mocked — the goal is to demonstrate the recording surface, not
 * to depend on a network call. Each tool invocation lands as a commit in
 * `.agentgit/`. After the run finishes the script prints the suggested
 * `agentgit log` command and the path to launch the desktop UI.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapAgentJS } from "@agentgit/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Mock LangChain ReAct agent. Real ReAct loops alternate LLM thought / tool
 * action steps; the mock simply scripts a 2-step trace so this example is
 * deterministic offline.
 */
class ReactAgent {
  steps: { thought: string; tool: "search" | "calculator"; input: unknown }[];

  constructor() {
    this.steps = [
      {
        thought: "Need a fact to ground the answer",
        tool: "search",
        input: { query: "speed of light in m/s" },
      },
      {
        thought: "Now compute light-seconds in a year",
        tool: "calculator",
        input: { expr: "299792458 * 60 * 60 * 24 * 365" },
      },
    ];
  }

  async run(_prompt: string): Promise<{ answer: string }> {
    let last: unknown = null;
    for (const step of this.steps) {
      console.log(`[thought] ${step.thought}`);
      if (step.tool === "search") {
        last = await this.search(step.input as { query: string });
      } else {
        last = await this.calculator(step.input as { expr: string });
      }
    }
    return { answer: String(last) };
  }

  async search({ query }: { query: string }): Promise<string> {
    // Mocked search backend — deterministic for the example.
    return `mock-search(${query}) → "299,792,458 m/s"`;
  }

  async calculator({ expr }: { expr: string }): Promise<number> {
    // Tiny safe numeric eval — only accepts digits, whitespace, * + - / . ( )
    if (!/^[0-9+\-*/.()\s]+$/.test(expr)) {
      throw new Error(`unsafe expr: ${expr}`);
    }
    // eslint-disable-next-line no-new-func
    return Function(`"use strict"; return (${expr});`)();
  }
}

async function main(): Promise<void> {
  const repoDir = resolve(join(__dirname, ".agentgit"));
  mkdirSync(repoDir, { recursive: true });

  const agent = new ReactAgent();
  const wrapped = wrapAgentJS(agent, {
    repoDir,
    sessionName: "langchain-react",
    sessionMetadata: { example: "langchain-react-agent", framework: "langchain" },
    // Disable confirmation guard so the example runs unattended.
    guards: false,
  });

  await wrapped.run("How far does light travel in a year?");
  wrapped.agentgit.end();

  const { sessionId, repo } = wrapped.agentgit;
  const commits = repo.log(sessionId);

  console.log("─────────────────────────────────────────");
  console.log(`✓  ${commits.length} commits recorded in .agentgit/`);
  console.log(`   Session: ${sessionId}`);
  console.log("─────────────────────────────────────────");
  console.log("\nNext steps:");
  console.log(`  pnpm exec agentgit log -s ${sessionId}`);
  console.log(`  pnpm --filter @agentgit/ui dev   # opens the Tauri UI`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
