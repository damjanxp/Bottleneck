import { describe, expect, it } from "vitest";
import type { Venue } from "@bottleneck/schema";
import { blankVenue } from "./edits.ts";
import { addShape, changeKind, duplicateElement, elementAt, moveElement, shapePoints } from "./shapes.ts";
import { DEFAULT_TRACE, fillHoles, floodRegion, simplifyRing, traceOutline, traceRegion } from "./trace.ts";

/** A w × h RGBA image filled with `bg`, with rectangles painted in other colours. */
function image(w: number, h: number, bg: [number, number, number], rects: { x: number; y: number; w: number; h: number; c: [number, number, number] }[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([...bg, 255], i * 4);
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) d.set([...r.c, 255], (y * w + x) * 4);
  return d;
}

const GREY: [number, number, number] = [230, 230, 230];
const GREEN: [number, number, number] = [170, 220, 170];
const DARK: [number, number, number] = [60, 60, 60];

describe("tracing an area on a map image", () => {
  it("a rectangle becomes exactly its four corners", () => {
    const img = image(100, 80, GREY, [{ x: 20, y: 10, w: 40, h: 30, c: GREEN }]);
    const r = traceRegion(img, 100, 80, { px: 35, py: 25 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pixels).toBe(1200);
    expect(r.ring).toEqual([
      { px: 20, py: 10 },
      { px: 60, py: 10 },
      { px: 60, py: 40 },
      { px: 20, py: 40 },
    ]);
  });

  it("an L-shaped area gives its six corners", () => {
    const img = image(100, 100, GREY, [
      { x: 10, y: 10, w: 20, h: 60, c: GREEN },
      { x: 30, y: 50, w: 40, h: 20, c: GREEN },
    ]);
    const r = traceRegion(img, 100, 100, { px: 15, py: 15 });
    expect(r.ok && r.ring.length).toBe(6);
  });

  it("labels and icons inside an area are closed over (holes are filled)", () => {
    const img = image(100, 80, GREY, [
      { x: 20, y: 10, w: 40, h: 30, c: GREEN },
      { x: 30, y: 20, w: 8, h: 4, c: DARK }, // a label in the park
    ]);
    const r = traceRegion(img, 100, 80, { px: 22, py: 12 });
    expect(r.ok && r.ring.length).toBe(4);
    const { mask } = floodRegion(img, 100, 80, 22, 12, DEFAULT_TRACE.tolerance);
    expect(fillHoles(mask, 100, 80).reduce((s, v) => s + v, 0)).toBe(1200);
  });

  it("the tolerance decides which colours belong together", () => {
    const img = image(60, 60, GREY, [
      { x: 0, y: 0, w: 30, h: 60, c: [200, 200, 200] },
      { x: 30, y: 0, w: 30, h: 60, c: [212, 212, 212] }, // 20.8 apart
    ]);
    expect(floodRegion(img, 60, 60, 5, 5, 10).size).toBe(1800);
    expect(floodRegion(img, 60, 60, 5, 5, 30).size).toBe(3600);
  });

  it("refuses a click on a thin line, outside the image, or a region that is nearly the whole image", () => {
    const img = image(100, 80, GREY, [{ x: 10, y: 10, w: 80, h: 2, c: DARK }]);
    expect(traceRegion(img, 100, 80, { px: 50, py: 11 })).toEqual({ ok: false, reason: "too-small" });
    expect(traceRegion(img, 100, 80, { px: 150, py: 11 })).toEqual({ ok: false, reason: "outside" });
    expect(traceRegion(img, 100, 80, { px: 50, py: 50 })).toEqual({ ok: false, reason: "too-large" });
  });

  it("the outline of a single pixel and simplifying a ring", () => {
    const mask = new Uint8Array(9);
    mask[4] = 1;
    expect(traceOutline(mask, 3, 3)).toEqual([
      { px: 1, py: 1 },
      { px: 2, py: 1 },
      { px: 2, py: 2 },
      { px: 1, py: 2 },
    ]);
    const square = [
      { px: 0, py: 0 },
      { px: 5, py: 0.2 },
      { px: 10, py: 0 },
      { px: 10, py: 10 },
      { px: 0, py: 10 },
    ];
    expect(simplifyRing(square, 1)).toHaveLength(4);
  });
});

describe("ready-made shapes and moving elements", () => {
  const v: Venue = blankVenue("v", "V");

  it("shapes fill the dragged box, whichever corners are used", () => {
    expect(shapePoints("rectangle", { x: 10, y: 8 }, { x: 0, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 8 },
      { x: 0, y: 8 },
    ]);
    expect(shapePoints("circle", { x: 0, y: 0 }, { x: 10, y: 10 })).toHaveLength(24);
    expect(shapePoints("lshape", { x: 0, y: 0 }, { x: 10, y: 10 })).toHaveLength(6);
    expect(shapePoints("ushape", { x: 0, y: 0 }, { x: 10, y: 10 })).toHaveLength(8);
    expect(addShape(v, "walkable", "rectangle", { x: 0, y: 0 }, { x: 0.2, y: 5 })).toBeNull();
  });

  it("move, duplicate, change kind and pick by position", () => {
    const a = addShape(v, "walkable", "rectangle", { x: 0, y: 0 }, { x: 20, y: 10 });
    expect(a).not.toBeNull();
    if (!a) return;
    const moved = moveElement(a.venue, a.id, 5, -2);
    expect(moved.walkableAreas[0]?.polygon.outer[0]).toEqual({ x: 5, y: -2 });
    const d = duplicateElement(moved, a.id);
    expect(d?.venue.walkableAreas).toHaveLength(2);
    const k = changeKind(moved, a.id, "obstacle");
    expect(k.venue.walkableAreas).toHaveLength(0);
    expect(k.venue.obstacles[0]?.id).toBe(k.id);
    expect(elementAt(k.venue, { x: 10, y: 3 })).toBe(k.id);
    expect(elementAt(k.venue, { x: 100, y: 3 })).toBeNull();
  });
});
