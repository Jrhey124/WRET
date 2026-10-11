import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90000,
  expect: { timeout: 15000 },
  use: {
    baseURL: process.env.WRET_BASE_URL || "http://127.0.0.1:4173",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: process.env.WRET_BASE_URL ? undefined : {
    command: "node scripts/serve-test.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGINT", timeout: 1000 },
  },
  projects: [
    {
      name: process.env.WRET_BROWSER || "chromium",
      use: {
        browserName: "chromium",
        channel: process.env.WRET_BROWSER || undefined,
      },
    },
  ],
});
