import { Repository } from "@agentgit/core";

/**
 * `agentgit merge-base <a> <b>`
 *
 * Prints the lowest common ancestor of the two refs. Each argument may be a
 * branch name (`<name>` or `sessions/<name>`) or a (possibly abbreviated)
 * commit hash. Exits non-zero if either ref does not resolve or if the two
 * histories are disjoint.
 */
export function mergeBaseCommand(
  agentgitDir: string,
  refA: string,
  refB: string,
): number {
  const repo = Repository.open(agentgitDir);
  try {
    const a = resolveRef(repo, refA);
    if (!a) {
      console.error(`fatal: ref not found: ${refA}`);
      return 1;
    }
    const b = resolveRef(repo, refB);
    if (!b) {
      console.error(`fatal: ref not found: ${refB}`);
      return 1;
    }
    const base = repo.mergeBase(a, b);
    if (!base) {
      console.error(`fatal: no common ancestor between ${refA} and ${refB}`);
      return 1;
    }
    console.log(base);
    return 0;
  } finally {
    repo.index.close();
  }
}

function resolveRef(repo: Repository, ref: string): string | null {
  const direct = repo.refs.getRef(ref);
  if (direct) return direct;
  const branch = repo.refs.getRef(`sessions/${ref}`);
  if (branch) return branch;
  try {
    return repo.index.resolveHash(ref);
  } catch {
    return null;
  }
}
