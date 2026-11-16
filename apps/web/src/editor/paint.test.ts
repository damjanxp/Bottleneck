import { describe, expect, it } from "vitest";
import type { Point, Venue } from "@bottleneck/schema";
import { blankVenue } from "./edits.ts";
import { mergePolygon, paintPath } from "./paint.ts";
import { gridArea, gridToPolygons, makeGrid, paintStroke, rasterizePolygon } from "./raster.ts";
import { shapePoints } from "./shapes.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => shapePoints("rectangle", { x: x0, y: y0 }, { x: x1, y: y1 });
const area = (r: readonly Point[]) => {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += ((r[j] as Point).x + (r[i] as Point).x) * ((r[j] as Point).y - (r[i] as Point).y);
  return Math.abs(s / 2);
};

describe("painting on a grid", () => {
  it("a rasterised rectangle comes back as the same rectangle", () => {
    const g = makeGrid({ minX: 0, minY: 0, maxX: 20, maxY: 10 }, 0.25);
    rasterizePolygon(g, { outer: rect(2, 2, 12, 8) });
    expect(gridArea(g)).toBeCloseTo(60, 6);
    const polys = gridToPolygons(g);
    expect(polys).toHaveLength(1);
    expect(polys[0]?.outer).toHaveLength(4);
    expect(area(polys[0]?.outer ?? [])).toBeCloseTo(60, 6);
  });

  it("a brush stroke has the brush's width", () => {
    const g = makeGrid({ minX: -5, minY: -5, maxX: 45, maxY: 5 }, 0.1);
    paintStroke(g, [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
    ], 2);
    // A 40 m stroke 4 m wide, with round ends: 160 + π·4 ≈ 172.6 m².
    expect(gridArea(g)).toBeGreaterThan(168);
    expect(gridArea(g)).toBeLessThan(177);
  });

  it("an area with an obstacle-shaped gap keeps it as a hole", () => {
    const g = makeGrid({ minX: 0, minY: 0, maxX: 30, maxY: 30 }, 0.5);
    rasterizePolygon(g, { outer: rect(0, 0, 30, 30) });
    rasterizePolygon(g, { outer: rect(10, 10, 20, 20) }, 0);
    const polys = gridToPolygons(g);
    expect(polys).toHaveLength(1);
    expect(polys[0]?.holes).toHaveLength(1);
    expect(area(polys[0]?.holes?.[0] ?? [])).toBeCloseTo(100, 6);
  });
});

describe("connected areas in a venue", () => {
  const v: Venue = blankVenue("v", "V");

  it("two overlapping walkable rectangles become one area", () => {
    const a = mergePolygon(v, "walkable", { outer: rect(0, 0, 20, 10) });
    const b = mergePolygon(a.venue, "walkable", { outer: rect(15, 5, 40, 20) });
    expect(b.venue.walkableAreas).toHaveLength(1);
    expect(area(b.venue.walkableAreas[0]?.polygon.outer ?? [])).toBeCloseTo(200 + 375 - 25, 0);
    expect(b.venue.walkableAreas[0]?.id).toBe("area-1");
  });

  it("separate rectangles stay separate, and a brush stroke between them joins them", () => {
    const a = mergePolygon(v, "walkable", { outer: rect(0, 0, 10, 10) });
    const b = mergePolygon(a.venue, "walkable", { outer: rect(30, 0, 40, 10) });
    expect(b.venue.walkableAreas).toHaveLength(2);
    const c = paintPath(b.venue, "walkable", [
      { x: 8, y: 5 },
      { x: 32, y: 5 },
    ], 1.5);
    expect(c.venue.walkableAreas).toHaveLength(1);
  });

  it("erasing across an area splits it in two; other kinds are not touched", () => {
    const a = mergePolygon(v, "walkable", { outer: rect(0, 0, 40, 10) });
    const withObstacle = mergePolygon(a.venue, "obstacle", { outer: rect(5, 2, 7, 4) });
    const e = paintPath(withObstacle.venue, "walkable", [
      { x: 20, y: -2 },
      { x: 20, y: 12 },
    ], 1, true);
    expect(e.venue.walkableAreas).toHaveLength(2);
    expect(e.venue.obstacles).toEqual(withObstacle.venue.obstacles);
  });
});
