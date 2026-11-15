/**
 * The venue editor (Phase 5): draw a venue (walkable area, source, gate group with 4 lanes,
 * destination), check it, undo and redo, save, reload the page: the saved venue is unchanged and
 * appears in the venue list.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    // `vite preview` has no API: the server check's 404 is expected on static hosting.
    if (m.type() === "error" && !/status of 404/.test(m.text())) problems.push(`console error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  return problems;
}

/** Clicks the venue point (x, y) in metres on the SVG canvas (viewBox with preserveAspectRatio "xMidYMid meet"). */
async function clickAt(canvas: Locator, x: number, y: number): Promise<void> {
  const { box, vb } = await canvas.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { box: { x: r.x, y: r.y, w: r.width, h: r.height }, vb: (el.getAttribute("viewBox") ?? "0 0 100 60").split(" ").map(Number) };
  });
  const [vx, vy, vw, vh] = vb as [number, number, number, number];
  const s = Math.min(box.w / vw, box.h / vh);
  const ox = (box.w - vw * s) / 2;
  const oy = (box.h - vh * s) / 2;
  await canvas.click({ position: { x: ox + (x - vx) * s, y: oy + (y - vy) * s } });
}

const storedVenues = (page: Page) => page.evaluate(() => window.localStorage.getItem("bottleneck.venues.v1"));

test("[test] draw a venue, save, reload: unchanged", async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Edit venue" }).click();
  await expect(page.getByRole("heading", { name: "Venue editor" })).toBeVisible();
  const canvas = page.getByTestId("venue-canvas");
  await canvas.scrollIntoViewIfNeeded();

  await page.getByLabel("Venue name").fill("Test hall");

  await page.getByRole("button", { name: "Walkable area", exact: true }).click();
  for (const [x, y] of [
    [5, 5],
    [95, 5],
    [95, 55],
    [5, 55],
  ] as const)
    await clickAt(canvas, x, y);
  await page.getByRole("button", { name: "Finish shape" }).click();

  await page.getByRole("button", { name: "Source", exact: true }).click();
  await clickAt(canvas, 10, 30);

  await page.getByRole("button", { name: "Gate line", exact: true }).click();
  await clickAt(canvas, 50, 45);
  await clickAt(canvas, 50, 15);

  await page.getByRole("button", { name: "Destination", exact: true }).click();
  for (const [x, y] of [
    [80, 20],
    [92, 20],
    [92, 40],
    [80, 40],
  ] as const)
    await clickAt(canvas, x, y);
  await canvas.press("Enter");

  await expect(page.getByText("No problems found.")).toBeVisible();
  await expect(page.getByLabel("Lanes gate-1")).toHaveValue("4");

  // Undo removes the destination (and the checks say so); redo brings it back.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByLabel("Destination destination-1")).toHaveCount(0);
  await expect(page.getByTestId("venue-problems")).toContainText("Add at least one destination");
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.getByLabel("Destination destination-1")).toBeVisible();
  await expect(page.getByText("No problems found.")).toBeVisible();

  await page.getByRole("button", { name: "Save venue" }).click();
  await expect(page.getByText(/Saved “Test hall”/)).toBeVisible();
  const saved = await storedVenues(page);
  expect(saved).not.toBeNull();
  const venue = (JSON.parse(saved as string) as { venues: { venue: { name: string; walkableAreas: unknown[]; sources: unknown[]; gateGroups: { laneCount: number }[]; destinations: unknown[] } }[] }).venues[0]?.venue;
  expect(venue?.name).toBe("Test hall");
  expect([venue?.walkableAreas.length, venue?.sources.length, venue?.gateGroups.length, venue?.destinations.length]).toEqual([1, 1, 1, 1]);
  expect(venue?.gateGroups[0]?.laneCount).toBe(4);

  // Reload: the venue is listed, opens in the editor, and the stored document is byte-for-byte the same.
  await page.reload();
  const picker = page.getByRole("combobox", { name: "Venue" }).first();
  await picker.selectOption({ label: "Test hall (my venue)" });
  await page.getByRole("tab", { name: "Edit venue" }).click();
  await expect(page.getByRole("combobox", { name: "Start from" })).toContainText("Editing “Test hall”");
  await expect(page.getByLabel("Lanes gate-1")).toHaveValue("4");
  await expect(page.getByText("No problems found.")).toBeVisible();
  expect(await storedVenues(page)).toBe(saved);

  expect(problems).toEqual([]);
});
