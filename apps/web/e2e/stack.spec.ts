/**
 * Sharing and server jobs against the full stack (Caddy + API + sidecar + Postgres). Runs only when
 * E2E_STACK_URL is set, e.g.
 *   npm run stack:up
 *   E2E_STACK_URL=http://localhost:8080 npx playwright test stack
 * Publishes the concert venue, opens the read-only link (editing disabled), opens the edit link
 * (the fragment disappears from the address bar), runs a small server batch and deletes the venue.
 * Note: the API allows 10 new venues per hour per IP.
 */

import { expect, test, type Page } from "@playwright/test";

const STACK = process.env.E2E_STACK_URL;

test.skip(!STACK, "set E2E_STACK_URL (e.g. http://localhost:8080) to run against the full stack");
test.use({ baseURL: STACK });

function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  return problems;
}

test("publish a venue, open the share and edit links, run a server batch", async ({ page, context }) => {
  test.setTimeout(300_000);
  const problems = watchProblems(page);

  await page.goto("/");
  await expect(page.getByLabel("Event clock")).toBeVisible();
  await page.getByRole("button", { name: "Hide the map" }).click();

  // The API is detected (same origin): the section appears.
  const shareTab = page.getByRole("tab", { name: "Share & server" });
  await expect(shareTab).toBeVisible();
  await shareTab.click();
  await expect(page.getByRole("heading", { name: /Publish “.+” to the server/ })).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();

  // The first example scenario goes along by default; a refused scenario would show "Published, but…".
  await expect(page.getByText("Published with 1 scenario.")).toBeVisible();
  const editField = page.getByTestId("edit-link");
  await expect(editField).toBeVisible();
  await expect(page.getByText(/shown only once/)).toBeVisible();
  const editLink = await editField.inputValue();
  const shareLink = await page.getByTestId("share-link").inputValue();
  expect(editLink).toMatch(/\/v\/[a-z2-7]{26}#k=[A-Za-z0-9_-]{43}$/);
  expect(shareLink).toMatch(/\/v\/[a-z2-7]{26}#t=[A-Za-z0-9_-]{43}$/);
  const venuePath = new URL(editLink).pathname;

  // Read-only link in a second tab: the fragment is removed, editing is disabled.
  const reader = await context.newPage();
  const readerProblems = watchProblems(reader);
  await reader.goto(shareLink);
  await expect(reader.getByText(/Read-only link: you can look and simulate/)).toBeVisible();
  expect(reader.url()).toBe(new URL(venuePath, STACK).toString());
  await reader.getByRole("button", { name: "Hide the map" }).click();
  await reader.getByRole("tab", { name: "Share & server" }).click();
  await expect(reader.getByTestId("access-level")).toContainText("Read-only");
  await expect(reader.getByRole("button", { name: "Submit to the server" })).toBeDisabled();
  await expect(reader.getByRole("button", { name: "Delete venue" })).toBeDisabled();
  await expect(reader.getByRole("button", { name: "Rotate edit key" })).toBeDisabled();
  await reader.close();
  expect(readerProblems).toEqual([]);

  // Edit link: the key leaves the address bar at once.
  await page.goto(editLink);
  await expect(page.getByText(/You opened the private edit link/)).toBeVisible();
  expect(page.url()).toBe(new URL(venuePath, STACK).toString());
  expect(await page.evaluate(() => window.location.hash)).toBe("");
  await page.getByRole("button", { name: "Hide the map" }).click();
  await page.getByRole("tab", { name: "Share & server" }).click();
  await expect(page.getByTestId("access-level")).toContainText("Edit link");

  // A small server batch (3 seeds), followed by polling until it finishes.
  await page.getByLabel("Job", { exact: true }).selectOption("batch");
  await page.getByLabel("Seeds", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Submit to the server" }).click();
  await expect(page.getByText("Submitted.", { exact: false })).toBeVisible();
  const row = page.getByTestId("job-row").first();
  await expect(row).toHaveAttribute("data-status", "succeeded", { timeout: 180_000 });
  await row.getByRole("button", { name: "Show result" }).click();
  const result = page.getByTestId("batch-result");
  await expect(result).toContainText("computed on the server (trusted)");
  await expect(result).toContainText("Peak-hour p95 wait");
  await expect(result.getByRole("row")).not.toHaveCount(1);

  // The job's runs are stored and marked as trusted.
  await page.getByRole("region", { name: "Stored runs" }).getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("cell", { name: /computed on the server \(trusted\)/ }).first()).toBeVisible();

  // Clean up: delete the venue (second click confirms).
  await page.getByRole("button", { name: "Delete venue" }).click();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page).toHaveURL(new URL("/", STACK).toString());

  expect(problems).toEqual([]);
});
