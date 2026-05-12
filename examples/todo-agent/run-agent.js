// @ts-check
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapAgentJS } from "@agentgit/sdk";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TODOS_FILE = join(__dirname, "todos.json");

/**
 * A simple to-do list agent that reads/writes todos.json via tool calls.
 * wrapAgentJS intercepts every internal this.tool() call and records it
 * as a content-addressed commit in the .agentgit/ store.
 */
class TodoAgent {
  constructor() {
    this.todos = [];
  }

  /**
   * Entry point — wrapAgentJS intercepts this and records a prompt commit,
   * then calls run() with the proxy as `this` so all internal tool calls
   * are also intercepted and committed.
   */
  async run(prompt) {
    console.log(`\n[agent] "${prompt}"`);

    const [action, ...rest] = prompt.split(":").map((s) => s.trim());
    const arg = rest.join(":").trim();

    if (action === "add") {
      await this.addTodo({ task: arg });
    } else if (action === "complete") {
      await this.completeTodo({ index: Number(arg) });
    } else if (action === "list") {
      await this.listTodos();
    }

    await this.saveTodos();
    return { ok: true };
  }

  async addTodo({ task }) {
    const todo = { id: Date.now(), task, done: false };
    this.todos.push(todo);
    console.log(`  [tool] addTodo  → "${task}" (total: ${this.todos.length})`);
    return todo;
  }

  async completeTodo({ index }) {
    const todo = this.todos[index];
    if (todo) {
      todo.done = true;
      console.log(`  [tool] completeTodo  → #${index} "${todo.task}" ✓`);
      return todo;
    }
    return null;
  }

  async listTodos() {
    console.log(`  [tool] listTodos  → ${this.todos.length} item(s)`);
    return [...this.todos];
  }

  async saveTodos() {
    const data = JSON.stringify(this.todos, null, 2);
    await writeFile(TODOS_FILE, data, "utf8");
    console.log(`  [tool] saveTodos  → wrote ${this.todos.length} todo(s) to todos.json`);
    return { path: TODOS_FILE, count: this.todos.length };
  }
}

async function main() {
  const repoDir = join(__dirname, ".agentgit");

  const agent = new TodoAgent();
  const wrapped = wrapAgentJS(agent, {
    repoDir,
    sessionName: "todo-session",
    sessionMetadata: { example: "todo-agent", version: "1.0" },
  });

  // Three prompts → each produces a prompt commit + tool-call commits
  await wrapped.run("add: Buy groceries");
  await wrapped.run("add: Write unit tests");
  await wrapped.run("complete: 0");

  wrapped.agentgit.end();

  const { sessionId, repo } = wrapped.agentgit;
  const commits = repo.log(sessionId);

  console.log(`\n─────────────────────────────────────────`);
  console.log(`✓  ${commits.length} commits recorded in .agentgit/`);
  console.log(`   Session: ${sessionId}`);
  console.log(`─────────────────────────────────────────`);

  if (commits.length >= 3) {
    const oldest = commits[commits.length - 1];
    const third = commits[commits.length - 3];
    console.log(`\nNext steps:`);
    console.log(`  pnpm exec agentgit log -s ${sessionId}`);
    console.log(`  pnpm exec agentgit diff ${oldest.hash} ${third.hash}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
