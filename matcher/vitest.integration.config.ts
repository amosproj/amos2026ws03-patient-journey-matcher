import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["mcp-server/src/integration/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    // The tests have no encoder: a SEMANTIC_MODEL from the developer's .env must not add ai_summary.
    env: { SEMANTIC_MODEL: "" },
  },
});
