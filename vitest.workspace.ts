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
]);
