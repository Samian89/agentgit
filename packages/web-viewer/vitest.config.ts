import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Force NODE_ENV=test so React loads its dev bundle (act() requires it).
// Without this, a parent shell exporting NODE_ENV=production breaks all RTL tests.
process.env.NODE_ENV = "test";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
