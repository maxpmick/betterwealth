import { defineConfig, devices } from "@playwright/test";

const apiPort = process.env.E2E_API_PORT ?? "3001";
const webPort = process.env.E2E_WEB_PORT ?? "5173";
const webOrigin = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 1,
  // CI adds GitHub check annotations and a JUnit report uploaded as a workflow artifact.
  reporter: process.env.CI
    ? [
        ["github"],
        ["junit", { outputFile: "reports/e2e.xml" }],
        ["html", { open: "never", outputFolder: "playwright-report" }],
      ]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: webOrigin,
    locale: "en-US",
    timezoneId: "America/New_York",
    colorScheme: "light",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: [
    {
      command: "bun e2e/start-api.ts",
      url: `http://127.0.0.1:${apiPort}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "bun run --cwd apps/web dev -- --strictPort",
      url: webOrigin,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
