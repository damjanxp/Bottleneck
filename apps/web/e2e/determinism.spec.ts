/**
 * Acceptance check: the same tiny scenario gives the same metrics hash in Node and in Chrome's Web
 * Worker. The Node side imports the engine source directly (Playwright transpiles TypeScript, the
 * workspace packages resolve through node_modules symlinks); the browser side runs the built app's
 * worker via the `?determinism=1` hook (apps/web/src/determinism/pageHook.ts).
 */

import { expect, test } from "@playwright/test";
import { createRun } from "@bottleneck/engine";
import { tinyScenario, tinyVenue } from "../src/determinism/tinyScenario.ts";

function nodeHash(): string {
  const run = createRun(tinyVenue, tinyScenario);
  while (!run.done) run.step();
  return run.metricsHash();
}

test("tiny scenario: metrics hash is identical in Node and in a Chrome Web Worker", async ({ page }) => {
  const expected = nodeHash();
  expect(expected).toMatch(/^[0-9a-f]{16,}$/);

  await page.goto("/?determinism=1");
  await page.waitForFunction(() => typeof window.__bottleneckDeterminismHash === "function");
  const inBrowser = await page.evaluate(() => (window as unknown as { __bottleneckDeterminismHash: () => Promise<string> }).__bottleneckDeterminismHash());

  console.log(`metrics hash (Node) = ${expected}\nmetrics hash (Chrome worker) = ${inBrowser}`);
  expect(inBrowser).toBe(expected);
});
