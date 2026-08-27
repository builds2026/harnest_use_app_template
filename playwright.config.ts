import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  workers: 1,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:3300", locale: "en-US", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3300",
    url: "http://127.0.0.1:3300/login",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
