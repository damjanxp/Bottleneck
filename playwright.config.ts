import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the production build served by `vite preview` (port 4173), which
// applies the same Content-Security-Policy as Vercel. They are not part of `npm run check`.
export default defineConfig({
  testDir: "apps/web/e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1, // the smoke test is CPU-heavy (software WebGL); running it beside another browser makes it flaky
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL: "http://localhost:4173", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
