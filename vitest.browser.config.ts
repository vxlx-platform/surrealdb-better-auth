import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    proxy: {
      "/api/auth": "http://127.0.0.1:3002",
      "/health": "http://127.0.0.1:3002",
    },
  },
  test: {
    include: ["tests/browser/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      headless: true,
    },
    fileParallelism: false,
    globalSetup: ["./tests/browser/global-setup.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
