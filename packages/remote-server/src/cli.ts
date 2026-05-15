#!/usr/bin/env node
import { buildServer } from "./server.js";

interface CliArgs {
  port: number;
  host: string;
  dataDir: string;
  tokenFile: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    port: 8787,
    host: "0.0.0.0",
    dataDir: "./data",
    tokenFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const key = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    const next = (): string => {
      if (inline !== null) return inline;
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`missing value for ${key}`);
      }
      return v;
    };
    switch (key) {
      case "--port":
        out.port = Number(next());
        break;
      case "--host":
        out.host = next();
        break;
      case "--data-dir":
        out.dataDir = next();
        break;
      case "--token-file":
        out.tokenFile = next();
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "agentgit-remote-server --port <n> --data-dir <path> --token-file <path>\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown arg: ${key}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tokenFile) {
    process.stderr.write("agentgit-remote-server: --token-file is required\n");
    process.exit(2);
  }
  const app = await buildServer({
    dataDir: args.dataDir,
    tokenFile: args.tokenFile,
    logger: true,
  });
  await app.listen({ port: args.port, host: args.host });
  process.stdout.write(
    `agentgit-remote-server listening on http://${args.host}:${args.port} (data=${args.dataDir})\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`agentgit-remote-server: ${(err as Error).message}\n`);
  process.exit(1);
});
