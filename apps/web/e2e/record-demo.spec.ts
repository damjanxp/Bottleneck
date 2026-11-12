/**
 * Records the README demo (docs/media/demo.gif source video and docs/media/screenshot.png).
 * Skipped unless RECORD_DEMO=1, so CI never runs it:  npm run record:demo
 * Output goes to RECORD_DEMO_DIR (default: ./demo-out, git-ignored by being outside docs/).
 * Convert the .webm to a GIF with ffmpeg afterwards (see the README / PROJECT.md).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const outDir = process.env.RECORD_DEMO_DIR ?? join(process.cwd(), "demo-out");

test.skip(process.env.RECORD_DEMO !== "1", "media recording only; set RECORD_DEMO=1");

test("record the README demo", async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(outDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByLabel("Event clock")).toBeVisible();
  await page.waitForTimeout(1500);

  // Jump to the busiest hour (an exact seek: headless software WebGL is too slow to play there in real time).
  await page.getByRole("button", { name: "Jump to peak" }).click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(outDir, "screenshot.png") });
  await page.waitForTimeout(2000);

  // Compare 3 vs 5 lanes.
  await page.getByRole("tab", { name: "Compare" }).click();
  await page.waitForTimeout(1000);
  await page.getByLabel("Scenario 1", { exact: true }).selectOption({ label: "Concert, 3 lanes" });
  await page.getByLabel("Scenario 2", { exact: true }).selectOption({ label: "Concert, 5 lanes" });
  await page.getByRole("button", { name: "Run comparison" }).click();
  const words = page.getByRole("list", { name: "Concert, 5 lanes against Concert, 3 lanes" });
  await expect(words).toBeVisible({ timeout: 240_000 });
  await words.scrollIntoViewIfNeeded();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(outDir, "compare.png") });
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(outDir, "compare2.png") });
  await context.close(); // finalises the video
});
