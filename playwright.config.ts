import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  // Kept outside Vitest's *.test/ *.spec discovery; both runners are mandatory
  // dependencies of the Docker runtime target.
  testMatch: "**/*.browser.ts",
  globalSetup: "./tests/browser/setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "./test-results/browser",
  reporter: [["list"], ["html", { outputFolder: "test-results/browser-report", open: "never" }]],
  use: { actionTimeout: 10_000, navigationTimeout: 15_000 },
  projects: [{ name: "chromium", use: { browserName: "chromium", headless: true } }]
});
