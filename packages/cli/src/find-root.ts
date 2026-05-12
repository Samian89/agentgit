import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function findAgentGitDir(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, ".agentgit");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireAgentGitDir(startDir?: string): string {
  const dir = findAgentGitDir(startDir);
  if (!dir) {
    console.error("fatal: not an agentgit repository (or any parent up to mount point)");
    process.exit(1);
  }
  return dir;
}
