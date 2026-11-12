/**
 * Replay with checkpoints (review C1) and the "+1 lane" fix (review A9), in the production build.
 *
 * Seeking back to time T restores an engine checkpoint in the worker and steps forward from it.
 * Determinism says this must give exactly the state of playing straight to T, so the people-by-state
 * counts shown after the backward seek must equal (1) a straight run to T in Node and (2) a forward
 * seek to T after a restart.
 */

import { expect, test, type Page } from "@playwright/test";
import { TICK_SECONDS, createRun } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";

const STATES = ["Not arrived yet", "Walking", "Queuing", "Being checked", "Inside", "Turned away"] as const;
/** AgentState values of the rows above (Pending, Walking, Queuing, InService, Inside, TurnedAway). */
const STATE_INDEX = [0, 1, 2, 3, 4, 8];

/** Scenario time of the people-by-state counts (the clock shows the scrubber's value while dragging). */
async function statsTime(page: Page): Promise<number> {
  return Number(await page.locator("section[aria-labelledby=states-heading]").getAttribute("data-time"));
}

async function counts(page: Page): Promise<number[]> {
  const out: number[] = [];
  for (const label of STATES) {
    const text = await page.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]").innerText();
    out.push(Number(text.replace(/[^0-9]/g, "")));
  }
  return out;
}

/** Sets the scrubber like a user would (React listens to the input event); returns the snapped target. */
async function scrubTo(page: Page, time: number): Promise<number> {
  return page.getByLabel("Simulated time").evaluate((el, t) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, String(t));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return Number(input.value);
  }, time);
}

async function waitForSeek(page: Page, target: number): Promise<void> {
  await expect.poll(() => statsTime(page), { timeout: 60_000, message: `the counts should reach ${target}` }).toBe(target);
  await expect(page.locator("progress")).toHaveCount(0);
}

test("seeking back restores a checkpoint and gives exactly the forward state; +1 lane compares runs", async ({ page }) => {
  test.setTimeout(360_000);
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
    if (m.text().startsWith("[replay]")) console.log(m.text());
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });

  await page.goto("/");
  await expect(page.getByLabel("Event clock")).toBeVisible();
  await page.getByLabel("Speed").selectOption("60");
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible(); // examples autoplay
  await pause.click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  // Forward: jump to the peak hour, then ten minutes further (checkpoints are saved on the way).
  await page.getByRole("button", { name: "Jump to peak" }).click();
  await expect(page.locator("progress")).toHaveCount(0, { timeout: 60_000 });
  const peak = await statsTime(page);
  const later = await scrubTo(page, peak + 600);
  await waitForSeek(page, later);

  // Backward: five minutes before the peak.
  let t0 = Date.now();
  const back = await scrubTo(page, peak - 300);
  expect(back).toBeLessThan(later);
  await waitForSeek(page, back);
  const backMs = Date.now() - t0;
  const afterBackSeek = await counts(page);

  // Ground truth: a straight run to the same time in Node.
  const concert = exampleVenues.find((v) => v.id === "belgrade-fair-concert");
  const scenario = concert?.scenarios[0];
  if (!concert || !scenario) throw new Error("concert example missing");
  const run = createRun(concert.venue, scenario);
  const target = run.toEngineTime(back);
  while (run.time + TICK_SECONDS / 2 <= target && !run.done) run.step();
  const nodeCounts = run.countsByState();
  expect(afterBackSeek).toEqual(STATE_INDEX.map((s) => nodeCounts[s]));
  expect(afterBackSeek[4]! + afterBackSeek[2]!).toBeGreaterThan(0); // the crowd is there

  // From a restart, forward to the same time.
  await page.getByRole("button", { name: "Restart" }).click();
  await expect.poll(() => statsTime(page)).toBeLessThan(back);
  t0 = Date.now();
  await scrubTo(page, back);
  await waitForSeek(page, back);
  const fwdMs = Date.now() - t0;
  expect(await counts(page)).toEqual(afterBackSeek);
  console.log(`[replay] backward seek ${backMs} ms, forward seek after restart ${fwdMs} ms (incl. UI debounce 300 ms)`);

  // "+1 lane" at the turnstiles: finishes this run, reloads with 4 lanes, shows before/after.
  // The map is hidden first: headless Chrome draws WebGL in software, which competes with the worker.
  await page.getByRole("button", { name: "Hide the map" }).click();
  t0 = Date.now();
  await page.getByRole("button", { name: "Add one lane at Main turnstiles" }).click();
  await expect(page.getByRole("heading", { name: /Before and after \+1 lane/ })).toBeVisible({ timeout: 180_000 });
  console.log(`[replay] +1 lane: finishing the run and reloading took ${Date.now() - t0} ms`);
  await expect(page.getByText("Before (3 lanes)")).toBeVisible();
  await expect(page.getByText("After (4 lanes)")).toBeVisible();
  await expect(page.getByText(/Changed here: Main turnstiles: 4 lanes/)).toBeVisible();

  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(problems).toEqual([]);
});
