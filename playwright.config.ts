import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "*.spec.ts",
  timeout: 120000,
  workers: 1,
  reporter: "list",
  outputDir: "output/playwright/test-results",
  use: {
    actionTimeout: 15000,
    viewport: { width: 1440, height: 960 },
    launchOptions: {
      executablePath:
        process.env.SPRUNG_FEA_CHROMIUM ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      args: ["--enable-webgl", "--use-gl=angle"],
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
  },
});
