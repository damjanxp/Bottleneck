/**
 * Phase 3 in the browser: the stand-alone car park example in the production build under the
 * production CSP. Cars appear in the car counts after "Jump to departures" (an exact seek in the
 * worker), and after running to the end the parking headline shows the time until the car park is
 * empty and the longest exit queue, equal to the same scenario run in Node (determinism, D-006).
 */

import { expect, test, type Page } from "@playwright/test";
import { createRun } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";
import { formatDuration } from "../src/sim/format.ts";

function nodeParking(): { timeToEmpty: number; exitQueueMetres: number } {
  const v = exampleVenues.find((x) => x.id === "standalone-car-park");
  const s = v?.scenarios[0];
  if (!v || !s) throw new Error("missing car park example");
  const r = createRun(v.venue, s);
  while (!r.done) r.step();
  const p = r.metrics().parking;
  if (!p) throw new Error("no parking metrics");
  return { timeToEmpty: p.lots[0]?.timeToEmpty ?? -1, exitQueueMetres: Math.max(...p.barriers.filter((b) => b.kind === "exit").map((b) => b.maxQueueMetres)) };
}

async function carCount(page: Page, state: string): Promise<number> {
  const text = await page.locator(`[data-car-state=${state}] dd`).innerText();
  return Number(text.replace(/[^0-9]/g, ""));
}

test("[test] the car park example: cars drive and park, the exit rush, time until empty", async ({ page }) => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
    if (/content security policy|violates the following/i.test(m.text())) problems.push(`CSP: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });

  await page.goto("/");
  await expect(page.getByLabel("Event clock")).toBeVisible();
  await page.getByRole("combobox", { name: /^Venue/ }).selectOption({ label: "Stand-alone car park" });
  await expect(page.locator("section[aria-labelledby=cars-heading]")).toBeVisible();
  await expect(page.locator("[data-lot=car-park]")).toBeVisible();

  // Jump to the busiest part of the departure curve: the clock says "Departures", cars are on site and leaving.
  await page.getByRole("button", { name: "Jump to departures" }).click();
  await expect(page.locator("[data-phase=departures]")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("progress")).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(async () => (await carCount(page, "Driving")) + (await carCount(page, "Parked")), { message: "cars should be on site", timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(async () => carCount(page, "Departed"), { message: "some cars should have left", timeout: 30_000 }).toBeGreaterThan(0);

  // Run to the end: the parking headline numbers are final and match Node.
  await page.getByRole("button", { name: "Run to the end" }).click();
  await expect(page.getByText("Run finished")).toBeVisible({ timeout: 120_000 });
  const expected = nodeParking();
  const tte = page.locator("[data-headline=timeToEmpty]");
  await expect(tte).toHaveAttribute("data-status", "empty");
  await expect(tte.locator("dd").first()).toHaveText(formatDuration(expected.timeToEmpty));
  await expect(page.locator("[data-headline=longestExitQueue] dd").first()).toContainText(`${Math.round(expected.exitQueueMetres)} m`);
  expect(await carCount(page, "Departed")).toBeGreaterThan(300);

  // Lot occupancy and exit queue charts open from the tables.
  await page.locator("[data-lot=car-park]").getByRole("button", { name: "Charts" }).click();
  await expect(page.getByText("Cars parked over time")).toBeVisible();
  await page.locator("[data-barrier=exit-barrier]").getByRole("button", { name: "Charts" }).click();
  await expect(page.getByText("Cars waiting over time (all lanes)")).toBeVisible();

  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(problems).toEqual([]);
});
