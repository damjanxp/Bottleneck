import { describe, expect, it } from "vitest";
import { applyDetection, classMask, clusterColours, roadLines, thin } from "./autodetect.ts";
import { blankVenue } from "./edits.ts";

type RGB = [number, number, number];
const OPEN: RGB = [242, 243, 245];
const ROAD: RGB = [255, 255, 255];
const PARK: RGB = [196, 232, 202];
const BUILDING: RGB = [222, 224, 228];
const WATER: RGB = [170, 214, 255];
const TEXT: RGB = [80, 80, 90];

/** A 300 × 200 "map": open ground, a road cross (8 px wide), a park with a label, two buildings, a pond. */
function syntheticMap(): { rgba: Uint8ClampedArray; w: number; h: number } {
  const w = 300;
  const h = 200;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const paint = (x0: number, y0: number, x1: number, y1: number, c: RGB) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set([...c, 255], (y * w + x) * 4);
  };
  paint(0, 0, w, h, OPEN);
  paint(0, 96, w, 104, ROAD);
  paint(146, 0, 154, h, ROAD);
  paint(20, 20, 120, 80, PARK);
  paint(40, 45, 90, 48, TEXT); // a label in the park
  paint(180, 20, 230, 70, BUILDING);
  paint(240, 20, 290, 70, BUILDING);
  paint(190, 130, 260, 180, WATER);
  return { rgba, w, h };
}

describe("reading a map screenshot", () => {
  const { rgba, w, h } = syntheticMap();
  const { clusters, assignment } = clusterColours(rgba, w, h);

  it("finds the map's colours and guesses what they are", () => {
    const guess = (c: RGB) => clusters.find((k) => Math.hypot(k.rgb[0] - c[0], k.rgb[1] - c[1], k.rgb[2] - c[2]) < 6);
    expect(guess(OPEN)?.guess).toBe("walkable");
    expect(guess(ROAD)?.guess).toBe("road");
    expect(guess(PARK)?.guess).toBe("walkable");
    expect(guess(BUILDING)?.guess).toBe("obstacle");
    expect(guess(WATER)?.guess).toBe("obstacle");
    expect(guess(TEXT)?.guess).toBe("ignore");
    expect(clusters[0]?.share).toBeGreaterThan(0.5);
  });

  it("text inside a park does not cut a hole in it", () => {
    const classes = clusters.map((c) => c.guess);
    const walk = classMask(assignment, w, h, classes, "walkable");
    expect(walk[46 * w + 60]).toBe(1);
  });

  it("thins a road band to a one-pixel line and finds the road cross as centrelines", () => {
    const band = new Uint8Array(40 * 12);
    for (let y = 2; y < 10; y++) for (let x = 2; x < 38; x++) band[y * 40 + x] = 1;
    const skel = thin(band, 40, 12);
    const count = skel.reduce((s, v) => s + v, 0);
    expect(count).toBeGreaterThan(20);
    expect(count).toBeLessThan(40);
    const classes = clusters.map((c) => c.guess);
    const lines = roadLines(classMask(assignment, w, h, classes, "road"), w, h, 20);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it("applies the detection as walkable areas, obstacles and two-way public roads", () => {
    const classes = clusters.map((c) => c.guess);
    const r = applyDetection(blankVenue("v", "V"), assignment, w, h, classes, { x: 0, y: 0 }, 0.5);
    expect(r.walkable).toBeGreaterThanOrEqual(1);
    expect(r.obstacles).toBe(3); // two buildings and the pond
    expect(r.roads).toBeGreaterThanOrEqual(3);
    expect(r.venue.roads?.every((road) => road.direction === "twoWay" && road.publicRoad && road.points.length >= 2)).toBe(true);
  });
});
