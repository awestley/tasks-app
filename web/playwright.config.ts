import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.TASKS_WEB_URL || "http://localhost:5173",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    // In CI, a failure keeps a trace (DOM, network and screenshots) for the uploaded results.
    trace: process.env.CI ? "retain-on-failure" : "off",
    launchOptions: process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {},
  },
  reporter: "list",
});
