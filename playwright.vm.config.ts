import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/vm",
  workers: 1,
  timeout: 240000,
  use: {
    baseURL: "http://127.0.0.1:8081",
    headless: true,
    channel: process.env.WRET_BROWSER || undefined,
  },
  webServer: {
    command: "node dist-companion/server.mjs",
    url: "http://127.0.0.1:8081",
    env: { WRET_PORT: "8081" },
    reuseExistingServer: false,
    timeout: 30000,
  },
});
