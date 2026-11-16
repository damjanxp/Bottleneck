import { defineConfig, devices } from "@playwright/test";

/** Port for the tests' own preview server; E2E_PORT picks another when 4173 is taken (e.g. by a preview you are looking at). */
const PORT = Number(process.env.E2E_PORT ?? 4173);

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
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Against the full stack (E2E_STACK_URL, stack.spec.ts) Caddy serves the app, so no local server.
  webServer: process.env.E2E_STACK_URL
    ? undefined
    : {
        command: `npm run build && npm run preview -w @bottleneck/web -- --port ${PORT}`,
        url: `http://localhost:${PORT}`,
        // Never reuse a server already on the port: a leftover `vite preview` would serve an old build
        // and the tests would pass or fail against stale code (it happened, D-070). Stop it instead.
        reuseExistingServer: false,
        timeout: 180_000,
      },
});
