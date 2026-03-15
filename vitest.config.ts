import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/browser/**/*"],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
