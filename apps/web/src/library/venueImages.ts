/**
 * Map images (screenshots of an online map, a site plan) for venues drawn in this browser
 * (redesign 2). The venue document keeps only the image's file name, pixel size and calibration
 * (`background`); the pixels live here, downscaled and JPEG-compressed, under the venue's id, in
 * their own versioned localStorage key so the scenario and venue stores stay small. The editor
 * traces areas on the image; the simulation draws it under the floor plan.
 *
 * Storage is injected for the tests; the page uses window.localStorage.
 */

import type { KeyValueStore } from "./storage.ts";

export const VENUE_IMAGES_KEY = "bottleneck.images.v1";
const FORMAT = 1;
/** Longest side after downscaling, pixels: enough to trace a venue, small enough for localStorage. */
export const MAX_IMAGE_SIDE = 1600;
/** A stored image larger than this (characters of data URL) is refused. */
export const MAX_IMAGE_CHARS = 2_500_000;

type Stored = Record<string, string>;

function read(store: KeyValueStore | null): Stored {
  try {
    const raw = store?.getItem(VENUE_IMAGES_KEY);
    if (!raw) return {};
    const d = JSON.parse(raw) as { format?: unknown; images?: unknown };
    if (d.format !== FORMAT || typeof d.images !== "object" || d.images === null) return {};
    const out: Stored = {};
    for (const [k, v] of Object.entries(d.images as Record<string, unknown>)) if (typeof v === "string" && v.startsWith("data:image/")) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function write(store: KeyValueStore | null, images: Stored): boolean {
  try {
    store?.setItem(VENUE_IMAGES_KEY, JSON.stringify({ format: FORMAT, images }));
    return store !== null;
  } catch {
    return false; // full: the image is not kept, the venue still is
  }
}

export function loadVenueImage(store: KeyValueStore | null, venueId: string): string | null {
  return read(store)[venueId] ?? null;
}

export function saveVenueImage(store: KeyValueStore | null, venueId: string, dataUrl: string): boolean {
  if (!dataUrl.startsWith("data:image/") || dataUrl.length > MAX_IMAGE_CHARS) return false;
  return write(store, { ...read(store), [venueId]: dataUrl });
}

export function removeVenueImage(store: KeyValueStore | null, venueId: string): void {
  const all = read(store);
  if (!(venueId in all)) return;
  delete all[venueId];
  write(store, all);
}

/** Pixel size after fitting (w, h) into MAX_IMAGE_SIDE. */
export function downscaledSize(w: number, h: number, max = MAX_IMAGE_SIDE): { w: number; h: number } {
  const f = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * f)), h: Math.max(1, Math.round(h * f)) };
}

export function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
