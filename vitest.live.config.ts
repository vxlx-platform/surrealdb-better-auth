import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/live/**/*.live.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/browser/**/*"],
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
