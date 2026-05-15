import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "core",
      root: "./packages/core",
      environment: "node",
    },
  },
  {
    test: {
      name: "cli",
      root: "./packages/cli",
      environment: "node",
    },
  },
  {
    test: {
      name: "sdk",
      root: "./packages/sdk",
      environment: "node",
    },
  },
  {
    test: {
      name: "remote-server",
      root: "./packages/remote-server",
      environment: "node",
    },
  },
  // web-viewer has its own vitest.config.ts (happy-dom + @vitejs/plugin-react),
  // so reference the package directory to inherit that config rather than
  // declaring environment inline.
  "./packages/web-viewer",
]);
