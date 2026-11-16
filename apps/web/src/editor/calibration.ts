/**
 * Two-click calibration of a background image (spec: venue editor; D-066). The user clicks two
 * points on the map image whose real distance they know (for example the ends of a 100 m hall
 * wall) and types that distance. The image's scale is then metres per pixel = distance / pixel
 * distance. Venue and image coordinates both have y pointing down, so a pixel (px, py) sits at
 * venue point origin + (px, py) · metresPerPixel (schema: `background.origin` is where the image's
 * top-left corner sits, in venue metres).
 *
 * Pure.
 */

import type { Point } from "@bottleneck/schema";

export interface PixelPoint {
  px: number;
  py: number;
}

export interface Calibration {
  metresPerPixel: number;
  origin: Point;
}

/** Calibration points closer together than this (pixels) are refused: one pixel of error would be over 10%. */
export const MIN_CALIBRATION_PIXELS = 10;

export type CalibrationResult = { ok: true; metresPerPixel: number } | { ok: false; reason: "same-point" | "too-close" | "bad-distance" };

/** Metres per pixel from two clicked pixels and the real distance between them. */
export function calibrate(a: PixelPoint, b: PixelPoint, metres: number): CalibrationResult {
  if (!Number.isFinite(metres) || metres <= 0) return { ok: false, reason: "bad-distance" };
  const pixels = Math.hypot(b.px - a.px, b.py - a.py);
  if (pixels === 0) return { ok: false, reason: "same-point" };
  if (pixels < MIN_CALIBRATION_PIXELS) return { ok: false, reason: "too-close" };
  return { ok: true, metresPerPixel: metres / pixels };
}

export function pixelToVenue(c: Calibration, p: PixelPoint): Point {
  return { x: c.origin.x + p.px * c.metresPerPixel, y: c.origin.y + p.py * c.metresPerPixel };
}

export function venueToPixel(c: Calibration, p: Point): PixelPoint {
  return { px: (p.x - c.origin.x) / c.metresPerPixel, py: (p.y - c.origin.y) / c.metresPerPixel };
}

/** Distance in metres between two venue points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Re-calibrating an image that already has shapes drawn on it: keeps every shape on the same spot
 * of the image by scaling venue coordinates about the image's origin. Returns the factor to apply
 * (new metres per pixel / old metres per pixel).
 */
export function rescaleFactor(oldMetresPerPixel: number, newMetresPerPixel: number): number {
  return newMetresPerPixel / oldMetresPerPixel;
}
