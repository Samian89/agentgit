import { defineConfig } from "vitepress";

export default defineConfig({
  title: "AgentGit",
  description: "Local-first Git for AI agents",
  base: "/",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/quickstart" },
      { text: "CLI Reference", link: "/cli-reference" },
      { text: "SDK API", link: "/sdk-api" },
    ],
    sidebar: [
      {
        text: "Getting Started",
        items: [
          { text: "Overview", link: "/" },
          { text: "Quickstart", link: "/quickstart" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI Reference", link: "/cli-reference" },
          { text: "SDK API", link: "/sdk-api" },
          { text: "Adapters", link: "/adapters" },
          { text: "Safety Guards", link: "/safety-guards" },
          { text: "Replay Export", link: "/replay-export" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/agentgit/agentgit" },
    ],
    footer: {
      message: "Released under the MIT License.",
    },
  },
});
