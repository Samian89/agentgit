import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Repository } from "@agentgit/core";

export function initCommand(dir: string = process.cwd()): void {
  const agentgitDir = resolve(dir, ".agentgit");
  const isNew = !existsSync(agentgitDir);
  const repo = Repository.init(agentgitDir);
  if (!repo.refs.getHead()) {
    repo.refs.setHead("ref: refs/sessions/main");
  }
  repo.index.close();
  if (isNew) {
    console.log(`Initialized empty AgentGit repository in ${agentgitDir}`);
  } else {
    console.log(`Reinitialized existing AgentGit repository in ${agentgitDir}`);
  }
}
