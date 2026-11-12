/**
 * Scenario library and scan logs in the production build (strict CSP): create a scenario, save,
 * reload (it persists in localStorage), export it as JSON (a Blob download), import the file again,
 * then export a finished run's scan log as CSV, import it in "Scan logs" and apply the fit.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("scenarios persist, export and import as JSON; a scan log round-trips into a new scenario", async ({ page }) => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });

  await page.goto("/");
  await expect(page.getByLabel("Event clock")).toBeVisible();
  await page.getByRole("button", { name: "Hide the map" }).click();

  // Create from defaults, edit, save (the save runs the build-time JSON Schema validator).
  await page.getByRole("tab", { name: "Scenarios" }).click();
  await page.getByRole("button", { name: "New scenario (defaults)" }).click();
  await page.getByLabel("Name", { exact: true }).fill("E2E evening");
  await page.getByLabel("Main turnstiles: Lanes").fill("70");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Main turnstiles: lanes must be a whole number from 1 to 64.");
  await page.getByLabel("Main turnstiles: Lanes").fill("6");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. “E2E evening”")).toBeVisible();

  // Reload: still there.
  await page.reload();
  await expect(page.getByLabel("Event clock")).toBeVisible();
  await page.getByRole("button", { name: "Hide the map" }).click(); // software WebGL in headless Chrome is slow
  await page.getByRole("tab", { name: "Scenarios" }).click();
  await expect(page.getByRole("paragraph").filter({ hasText: /^E2E evening$/ })).toBeVisible();

  // Export as JSON (download), then import the file again: it gets a new id.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("listitem").filter({ hasText: "E2E evening" }).getByRole("button", { name: "Export JSON" }).click()]);
  expect(download.suggestedFilename()).toBe("e2e-evening.scenario.json");
  const file = await download.path();
  const exported = JSON.parse(readFileSync(file, "utf8")) as { name: string; overrides: Record<string, { laneCount?: number }> };
  expect(exported.name).toBe("E2E evening");
  expect(exported.overrides["gate-main"]?.laneCount).toBe(6);
  await page.getByLabel("Import JSON…").setInputFiles(file);
  await expect(page.getByText("Imported “E2E evening”.")).toBeVisible();
  await expect(page.getByRole("paragraph").filter({ hasText: /^E2E evening$/ })).toHaveCount(2);

  // Scan log: finish the concert run, export its log, import it, apply the fit.
  await page.getByRole("tab", { name: "Simulate" }).click();
  await page.getByRole("button", { name: "Run to the end" }).click();
  await expect(page.getByText(/Run finished/)).toBeVisible({ timeout: 120_000 });
  const exportLog = page.getByRole("button", { name: "Export scan log (CSV)" });
  await expect(exportLog).toBeEnabled({ timeout: 120_000 });
  const [csvDownload] = await Promise.all([page.waitForEvent("download"), exportLog.click()]);
  expect(csvDownload.suggestedFilename()).toBe("concert-3-lanes.scan-log.csv");
  const csvPath = await csvDownload.path();
  expect(readFileSync(csvPath, "utf8").split("\n")[0]).toBe("time,seconds,lane,event");

  await page.getByRole("tab", { name: "Scan logs" }).click();
  await page.getByLabel("Import scan log (CSV)…").setInputFiles(csvPath);
  await expect(page.getByText(/rows read/)).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Main turnstiles" }).first();
  await expect(row).toContainText(/\d+\.\d\d s/);
  await page.getByRole("button", { name: "Apply to a new scenario" }).click();
  await expect(page.getByRole("heading", { name: /New scenario: Concert, 3 lanes, fitted from / })).toBeVisible();
  await expect(page.getByText(/Uses \d+ custom points/)).toBeVisible();

  expect(problems).toEqual([]);
});
