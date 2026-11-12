import { expect, test } from "@playwright/test";

test("the concert example loads, plays, and the self-check is bit-identical", async ({ page }) => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
    if (/content security policy|violates the following/i.test(m.text())) problems.push(`CSP: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });

  await page.goto("/");

  // Wait for the example to load (the clock shows once a scenario is loaded).
  const clock = page.getByLabel("Event clock");
  await expect(clock).toBeVisible();
  const startText = await clock.innerText();

  // Fastest speed, so people reach the queues quickly; then press Play unless it autoplays.
  await page.getByLabel("Speed").selectOption("60");
  const play = page.getByRole("button", { name: "Play", exact: true });
  if (await play.isVisible()) await play.click({ timeout: 5_000 }).catch(() => undefined); // it may have started meanwhile

  await expect.poll(async () => clock.innerText(), { message: "the clock should advance", timeout: 60_000 }).not.toBe(startText);

  // Headless Chrome renders in software and can play slowly, so jump to the busiest hour (an exact
  // seek in the worker) instead of waiting for the crowd to arrive in real time.
  await page.getByRole("button", { name: "Jump to peak" }).click();

  // People "Inside" or "Queuing" become > 0 (the state panel's rows are dt/dd pairs).
  const count = async (label: string) => {
    const text = await page.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]").innerText();
    return Number(text.replace(/[^0-9]/g, ""));
  };
  await expect
    .poll(async () => (await count("Queuing")) + (await count("Inside")), { message: "people should be queuing or inside", timeout: 40_000 })
    .toBeGreaterThan(0);

  await expect(page.getByText("bit-identical to Node")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(problems).toEqual([]);
});
