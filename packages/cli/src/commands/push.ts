import { Repository, pushSession } from "@agentgit/core";
import { getRemote } from "./remote.js";

export interface PushCommandOptions {
  /** Override token (otherwise loaded from config). */
  token?: string;
}

/**
 * `agentgit push <remote> <session>`
 *
 * `session` is a session id (or its name) — the head commit of that session
 * is pushed to `sessions/<id>` on the remote.
 */
export async function pushCommand(
  agentgitDir: string,
  remoteName: string,
  sessionRef: string,
  options: PushCommandOptions = {},
): Promise<number> {
  const remote = getRemote(agentgitDir, remoteName);
  if (!remote) {
    console.error(`push: unknown remote '${remoteName}'`);
    return 1;
  }
  const token = options.token ?? remote.token;
  if (!token) {
    console.error(`push: no token configured for remote '${remoteName}'`);
    return 1;
  }

  const repo = Repository.open(agentgitDir);

  // Resolve sessionRef: try id, then name.
  let session = repo.index.getSession(sessionRef);
  if (!session) {
    for (const s of repo.index.listSessions()) {
      if (s.name === sessionRef) {
        session = s;
        break;
      }
    }
  }
  if (!session) {
    console.error(`push: session not found: ${sessionRef}`);
    return 1;
  }
  if (!session.head) {
    console.error(`push: session '${session.name}' has no commits`);
    return 1;
  }

  try {
    const result = await pushSession(repo, {
      remote: remoteName,
      baseUrl: remote.url,
      token,
      sessionId: session.id,
    });
    process.stdout.write(
      `Pushed ${result.uploadedObjects} objects, ref ${result.pushedRef.name} → ${result.pushedRef.target.slice(0, 12)}\n`,
    );
    return 0;
  } catch (err) {
    console.error(`push: ${(err as Error).message}`);
    return 1;
  }
}
