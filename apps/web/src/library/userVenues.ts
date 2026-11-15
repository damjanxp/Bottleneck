/**
 * Venues drawn in the venue editor and saved in this browser (D-067). One localStorage key with a
 * version (like the scenario library, D-032): `{ format: 1, venues: [...] }`. An entry that is not
 * a venue-shaped object is skipped on load (the editor validates against the schema before saving,
 * so this only guards against a hand-edited or corrupted store). The catalogue (catalog.ts) lists
 * these venues next to the examples; components re-render through useUserVenues().
 *
 * Storage is injected for the tests; the browser uses window.localStorage.
 */

import { useSyncExternalStore } from "react";
import type { Venue } from "@bottleneck/schema";
import type { KeyValueStore } from "./storage.ts";

export const USER_VENUES_KEY = "bottleneck.venues.v1";
const FORMAT = 1;

export interface UserVenue {
  /** The venue's own id (always set for saved venues). */
  id: string;
  venue: Venue;
  savedAt: string;
}

function isVenueLike(v: unknown): v is Venue {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.name === "string" && Array.isArray(o.walkableAreas) && Array.isArray(o.gateGroups) && Array.isArray(o.sources) && Array.isArray(o.destinations);
}

export function loadUserVenues(store: KeyValueStore | null): UserVenue[] {
  try {
    const raw = store?.getItem(USER_VENUES_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as { format?: unknown; venues?: unknown };
    if (data.format !== FORMAT || !Array.isArray(data.venues)) return [];
    return data.venues.flatMap((e: unknown) => {
      const o = e as { venue?: unknown; savedAt?: unknown };
      return isVenueLike(o?.venue) ? [{ id: o.venue.id as string, venue: o.venue, savedAt: typeof o.savedAt === "string" ? o.savedAt : "" }] : [];
    });
  } catch {
    return [];
  }
}

export function saveUserVenues(store: KeyValueStore | null, list: readonly UserVenue[]): boolean {
  try {
    store?.setItem(USER_VENUES_KEY, JSON.stringify({ format: FORMAT, venues: list }));
    return store !== null;
  } catch {
    return false; // storage full or disabled: the caller says so
  }
}

/** Inserts or replaces by id; keeps the list in id order (stable, independent of save order). */
export function upsertUserVenue(list: readonly UserVenue[], venue: Venue, savedAt: string): UserVenue[] {
  const id = venue.id as string;
  return [...list.filter((v) => v.id !== id), { id, venue, savedAt }].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function removeUserVenue(list: readonly UserVenue[], id: string): UserVenue[] {
  return list.filter((v) => v.id !== id);
}

// ---- The page's store (browser only)

function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let current: readonly UserVenue[] | null = null;
const listeners = new Set<() => void>();

export function userVenues(): readonly UserVenue[] {
  current ??= typeof window === "undefined" ? [] : loadUserVenues(browserStore());
  return current;
}

/** Saves a venue in this browser; false if storage is not available. */
export function storeUserVenue(venue: Venue): boolean {
  const next = upsertUserVenue(userVenues(), venue, new Date().toISOString());
  const ok = saveUserVenues(browserStore(), next);
  current = next;
  for (const l of listeners) l();
  return ok;
}

export function deleteUserVenue(id: string): void {
  const next = removeUserVenue(userVenues(), id);
  saveUserVenues(browserStore(), next);
  current = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useUserVenues(): readonly UserVenue[] {
  return useSyncExternalStore(subscribe, userVenues, userVenues);
}
