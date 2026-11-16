/**
 * The venue editor's map-image flow (redesign 2): import a map screenshot, calibrate it with two
 * clicks and a known distance, and trace areas on it with the "magic wand". The image is generated
 * here (a plain PNG): a grey street background, a beige plaza with a green park inside.
 */

import { deflateSync, crc32 } from "node:zlib";
import { expect, test, type Locator } from "@playwright/test";

/** A minimal RGB PNG encoder (filter 0 on every row). */
function png(w: number, h: number, colour: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(colour(x, y), y * (w * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const inside = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

const MAP = png(400, 300, (x, y) => {
  if (inside(x, y, 100, 90, 180, 150)) return [170, 220, 170]; // park
  if (inside(x, y, 200, 180, 220, 182)) return [90, 90, 90]; // a thin label stroke on the plaza
  if (inside(x, y, 80, 60, 320, 240)) return [245, 235, 215]; // plaza
  return [200, 200, 200]; // streets
});

async function clickAt(canvas: Locator, x: number, y: number): Promise<void> {
  const { box, vb } = await canvas.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { box: { w: r.width, h: r.height }, vb: (el.getAttribute("viewBox") ?? "0 0 100 60").split(" ").map(Number) };
  });
  const [vx, vy, vw, vh] = vb as [number, number, number, number];
  const s = Math.min(box.w / vw, box.h / vh);
  await canvas.click({ position: { x: (box.w - vw * s) / 2 + (x - vx) * s, y: (box.h - vh * s) / 2 + (y - vy) * s } });
}

test("[test] import a map image, calibrate it and trace areas on it", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto("/");
  await page.getByRole("tab", { name: "Edit venue" }).click();
  const canvas = page.getByTestId("venue-canvas");

  // Import: the image is placed about 300 m wide at the origin (0.75 m per pixel), calibration is next.
  await page.getByLabel("Import map image").setInputFiles({ name: "map.png", mimeType: "image/png", buffer: MAP });
  await expect(page.getByText("Map image kept in this browser.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Calibrate", exact: true })).toHaveAttribute("aria-pressed", "true");

  // The plaza's top edge (pixels 80 to 320) is 120 m long: 0.5 m per pixel.
  await clickAt(canvas, 80 * 0.75, 60 * 0.75);
  await clickAt(canvas, 320 * 0.75, 60 * 0.75);
  await page.getByLabel("Distance (m)").fill("120");
  await page.getByRole("button", { name: "Apply scale" }).click();
  await expect(page.getByText("Scale: 0.500 m per pixel.")).toBeVisible();
  await page.getByRole("button", { name: "Trace area", exact: true }).click();

  // Trace the plaza as walkable floor: the park and the label inside it are closed over (4 corners).
  await clickAt(canvas, 250 * 0.5, 120 * 0.5);
  await expect(page.getByText("Traced an area with 4 corners.")).toBeVisible();
  await expect(page.getByLabel("Walkable area area-1")).toBeVisible();

  // Trace the park as a destination.
  await page.getByRole("group", { name: "Draw as" }).getByRole("button", { name: "Destination" }).click();
  await clickAt(canvas, 140 * 0.5, 120 * 0.5);
  await expect(page.getByLabel("Destination destination-1")).toBeVisible();

  // A click on the thin label is refused with a reason, not added.
  await page.getByRole("group", { name: "Draw as" }).getByRole("button", { name: "Obstacle" }).click();
  await clickAt(canvas, 210 * 0.5, 181 * 0.5);
  await expect(page.getByRole("alert")).toContainText("too small");

  // Detect areas by colour: the map's colours are listed with a guess each, and applying adds elements.
  await page.getByRole("button", { name: "Detect areas" }).click();
  await expect(page.getByTestId("detected-colours").getByRole("listitem")).not.toHaveCount(0);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText(/^Added \d+ walkable areas?, \d+ obstacles? and \d+ roads?\.$/)).toBeVisible();

  expect(problems).toEqual([]);
});
