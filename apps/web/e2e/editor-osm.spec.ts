/**
 * OpenStreetMap import in the venue editor (D-073): a small generated .osm file (a boulevard, a
 * fenced fair with a hall, a footway through the fence, a sidewalk and a zebra crossing, a tram
 * stop) becomes walkable ground, a road, a building, a suggested gate and a source.
 */

import { expect, test } from "@playwright/test";

const lat = (m: number) => 45 + m / 110574;
const lon = (m: number) => 20 + m / (Math.cos((45 * Math.PI) / 180) * 111320);
function smallFair(): string {
  let id = 0;
  const nodes: string[] = [];
  const node = (x: number, y: number, tags = "") => {
    id++;
    nodes.push(`<node id="${id}" lat="${lat(y).toFixed(8)}" lon="${lon(x).toFixed(8)}">${tags}</node>`);
    return id;
  };
  const way = (wid: number, refs: number[], tags: Record<string, string>) => `<way id="${wid}">${refs.map((r) => `<nd ref="${r}"/>`).join("")}${Object.entries(tags).map(([k, v]) => `<tag k="${k}" v="${v}"/>`).join("")}</way>`;
  const road = [node(-50, 20), node(250, 20)];
  const site = [node(10, 40), node(190, 40), node(190, 120), node(10, 120)];
  const fence = [node(10, 40), node(190, 40)];
  const hall = [node(80, 80), node(130, 80), node(130, 110), node(80, 110)];
  const foot = [node(100, 28), node(100, 80)];
  const sidewalk = [node(0, 28), node(200, 28)];
  const crossing = [node(100, 12), node(100, 28)];
  node(100, 8, '<tag k="railway" v="tram_stop"/><tag k="name" v="Sajam"/>');
  const ways = [
    way(1, road, { highway: "primary", name: "Bulevar", lanes: "4" }),
    way(2, [...site, site[0] as number], { landuse: "commercial", amenity: "exhibition_centre", name: "Small fair" }),
    way(3, fence, { barrier: "fence" }),
    way(4, [...hall, hall[0] as number], { building: "yes", name: "Hall 1" }),
    way(5, foot, { highway: "footway" }),
    way(6, sidewalk, { highway: "footway", footway: "sidewalk" }),
    way(7, crossing, { highway: "footway", footway: "crossing" }),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?><osm version="0.6"><bounds minlat="${lat(0)}" minlon="${lon(0)}" maxlat="${lat(130)}" maxlon="${lon(200)}"/>${nodes.join("")}${ways.join("")}</osm>`;
}

test("[test] import an OpenStreetMap export into the venue editor", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("tab", { name: "Edit venue" }).click();
  await page.getByLabel("Import OpenStreetMap").setInputFiles({ name: "fair.osm", mimeType: "application/xml", buffer: Buffer.from(smallFair()) });
  await expect(page.getByText(/^Imported 200 × 130 m: 1 walkable area, 1 building and obstacle, 1 road, 1 suggested gate, 1 source at stops\./)).toBeVisible();
  await expect(page.getByLabel("Venue name")).toHaveValue("Small fair");
  await expect(page.getByLabel("Obstacle obstacle-1")).toHaveValue("Hall 1");
  await expect(page.getByLabel("Road road-1")).toHaveValue("Bulevar");
  // Only the destination is missing: the import gives walkable ground, a gate and a source.
  await expect(page.getByTestId("venue-problems")).toContainText("Add at least one destination");
  await expect(page.getByTestId("venue-problems")).not.toContainText("Add at least one source");
  // Undo restores the drawing from before the import.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByLabel("Venue name")).toHaveValue("My venue");
  expect(errors).toEqual([]);
});
