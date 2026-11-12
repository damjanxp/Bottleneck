/**
 * Phase 2 acceptance check: comparing 3 vs 5 lanes on the concert example shows highlighted
 * differences. The comparison runs both scenarios to the end in background Web Workers (same seed:
 * common random numbers) in the production build under the production CSP. The numbers on the page
 * must equal the same scenarios run in Node (determinism, D-006), and the difference rows must carry
 * the better/worse marking in words, not only in colour. Swapping the order turns "better" into "worse".
 */

import { expect, test, type Page } from "@playwright/test";
import { createRun } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";

function nodeOutsideAtStart(scenarioId: string): number {
  const concert = exampleVenues.find((v) => v.id === "belgrade-fair-concert");
  const scenario = concert?.scenarios.find((s) => s.id === scenarioId);
  if (!concert || !scenario) throw new Error(`missing example ${scenarioId}`);
  const run = createRun(concert.venue, scenario);
  while (!run.done) run.step();
  return run.metrics().stillOutsideAtStart ?? -1;
}

async function compare(page: Page, first: string, second: string): Promise<void> {
  await page.getByLabel("Scenario 1", { exact: true }).selectOption({ label: first });
  await page.getByLabel("Scenario 2", { exact: true }).selectOption({ label: second });
  await page.getByRole("button", { name: "Run comparison" }).click();
}

test("[test] Comparing 3 vs 5 lanes on the concert example shows highlighted differences", async ({ page }) => {
  test.setTimeout(300_000);
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
  // The example autoplays; pause it so the comparison workers have the CPU.
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await pause.click();

  await page.getByRole("tab", { name: "Compare" }).click();
  const t0 = Date.now();
  await compare(page, "Concert, 3 lanes", "Concert, 5 lanes");
  const words = page.getByRole("list", { name: "Concert, 5 lanes against Concert, 3 lanes" });
  await expect(words).toBeVisible({ timeout: 240_000 });
  console.log(`[compare] 2 concert runs took ${Date.now() - t0} ms in the browser`);

  // Highlighted difference rows, with the verdict in words (not colour only).
  const outside = words.locator('li[data-measure="stillOutside"]');
  const p95 = words.locator('li[data-measure="p95PeakWait"]');
  await expect(outside).toHaveAttribute("data-verdict", "better");
  await expect(p95).toHaveAttribute("data-verdict", "better");
  await expect(outside).toContainText("better");
  await expect(p95).toContainText(/p95 wait, peak arrival hour: .+ → .+ \(−.+, better\)/);

  // The numbers are the Node numbers, exactly.
  const [three, five] = [nodeOutsideAtStart("concert-3-lanes"), nodeOutsideAtStart("concert-5-lanes")];
  const fmt = (n: number) => n.toLocaleString("en-GB");
  await expect(outside).toContainText(`Still outside at the start: ${fmt(three)} people → ${fmt(five)} people`);

  // The table marks the same cells, and the outside-at-start split is shown.
  await expect(page.locator('tr[data-measure="stillOutside"] [data-verdict="better"]')).toContainText("better");
  await expect(page.locator('tr[data-measure="onSite"]')).toBeVisible();
  await expect(page.locator('tr[data-measure="notArrived"]')).toBeVisible();
  // Capacity against demand: 3 lanes are over capacity at the busiest hour.
  await expect(page.getByRole("heading", { name: "Capacity against demand" }).last()).toBeVisible();
  await expect(page.getByText("over capacity").first()).toBeVisible();

  // The other way round, the same difference is "worse".
  await compare(page, "Concert, 5 lanes", "Concert, 3 lanes");
  const reversed = page.getByRole("list", { name: "Concert, 3 lanes against Concert, 5 lanes" });
  await expect(reversed).toBeVisible({ timeout: 240_000 });
  await expect(reversed.locator('li[data-measure="stillOutside"]')).toHaveAttribute("data-verdict", "worse");
  await expect(reversed.locator('li[data-measure="p95PeakWait"]')).toHaveAttribute("data-verdict", "worse");
  await expect(reversed.locator('li[data-measure="stillOutside"]')).toContainText("worse");

  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(problems).toEqual([]);
});
