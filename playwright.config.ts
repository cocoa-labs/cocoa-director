import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:3100", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "npm run dev -- --webpack --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PROVIDER_MODE: "mock", PROVIDER_CALLS_ENABLED: "", REQUIRE_AUTH: "false", NODE_NO_WARNINGS: "1",
      DATABASE_URL: "", BLOB_READ_WRITE_TOKEN: "", PRIVATE_BLOB_READ_WRITE_TOKEN: "",
      OPENAI_API_KEY: "", FAL_KEY: "", ELEVENLABS_API_KEY: "", AUTH_SECRET: "",
      // Simulated costs only. Exercise many independent workflows in this process.
      DAILY_BUDGET_CAP_USD_GLOBAL: "1000", DAILY_BUDGET_CAP_USD_PER_USER: "1000",
    },
  },
});
