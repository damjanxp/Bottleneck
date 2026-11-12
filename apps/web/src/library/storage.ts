/**
 * The user's scenarios in localStorage (review A6: no backend until Phase 4).
 *
 * Format, under one versioned key:
 *   bottleneck.scenarios.v1 = { "format": "bottleneck-scenario-library", "version": 1,
 *                               "entries": [{ "id", "schemaVersion", "savedAt", "scenario" }] }
 * Every entry carries the schemaVersion of its scenario document. Entries that are not readable or
 * not compatible with this build are dropped with a visible notice; their raw JSON is copied to
 * `bottleneck.scenarios.v1.dropped` first so nothing is lost silently. Every storage access is
 * wrapped in try/catch (private mode, a full quota or disabled storage must not break the page).
 */

import { SCHEMA_VERSION, type Scenario } from "@bottleneck/schema";

export const LIBRARY_KEY = "bottleneck.scenarios.v1";
export const DROPPED_KEY = "bottleneck.scenarios.v1.dropped";
export const LIBRARY_FORMAT = "bottleneck-scenario-library";
export const LIBRARY_VERSION = 1;
/** How many dropped entries are kept as a backup. */
const MAX_DROPPED = 50;

/** The subset of the Web Storage API used here (a Map-backed fake in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LibraryEntry {
  id: string;
  schemaVersion: number;
  /** ISO time of the last save. */
  savedAt: string;
  scenario: Scenario;
}

export interface DroppedEntry {
  name: string;
  reason: string;
}

export interface LoadResult {
  entries: LibraryEntry[];
  dropped: DroppedEntry[];
  /** Storage could not be read at all (disabled, or the stored text is not JSON). */
  error: string | null;
}

/** window.localStorage, or null where it is unavailable (some private modes throw on access). */
export function browserStorage(): KeyValueStore | null {
  try {
    const s = window.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function entryName(raw: unknown, k: number): string {
  if (isObject(raw) && isObject(raw.scenario) && typeof raw.scenario.name === "string") return raw.scenario.name;
  return `entry ${k + 1}`;
}

/** Shape and version checks that need no schema validator; full schema checks run later (dropInvalid). */
function checkEntry(raw: unknown): string | null {
  if (!isObject(raw)) return "not an object";
  if (typeof raw.id !== "string" || raw.id === "") return "no id";
  if (raw.schemaVersion !== SCHEMA_VERSION) return `saved with schemaVersion ${JSON.stringify(raw.schemaVersion)}, this build reads ${SCHEMA_VERSION}`;
  if (!isObject(raw.scenario)) return "no scenario";
  if (raw.scenario.schemaVersion !== SCHEMA_VERSION) return `scenario has schemaVersion ${JSON.stringify(raw.scenario.schemaVersion)}`;
  if (typeof raw.scenario.venueId !== "string") return "no venue";
  return null;
}

function backupDropped(store: KeyValueStore, raws: unknown[]): void {
  if (raws.length === 0) return;
  try {
    const prev = JSON.parse(store.getItem(DROPPED_KEY) ?? "[]") as unknown;
    const list = Array.isArray(prev) ? prev : [];
    store.setItem(DROPPED_KEY, JSON.stringify([...list, ...raws].slice(-MAX_DROPPED)));
  } catch {
    // The backup is best effort.
  }
}

/** Reads the library. Unreadable or incompatible entries are dropped (and backed up), never thrown. */
export function loadLibrary(store: KeyValueStore | null): LoadResult {
  if (!store) return { entries: [], dropped: [], error: "This browser does not allow saving (storage is disabled), so scenarios cannot be kept between visits." };
  let text: string | null;
  try {
    text = store.getItem(LIBRARY_KEY);
  } catch {
    return { entries: [], dropped: [], error: "Saved scenarios could not be read (storage access was refused)." };
  }
  if (text === null) return { entries: [], dropped: [], error: null };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    backupDropped(store, [text]);
    return { entries: [], dropped: [{ name: "all saved scenarios", reason: "the stored data was not valid JSON" }], error: null };
  }
  if (!isObject(doc) || doc.format !== LIBRARY_FORMAT || !Array.isArray(doc.entries)) {
    backupDropped(store, [doc]);
    return { entries: [], dropped: [{ name: "all saved scenarios", reason: "the stored data has an unknown format" }], error: null };
  }
  if (doc.version !== LIBRARY_VERSION) {
    backupDropped(store, [doc]);
    return { entries: [], dropped: [{ name: "all saved scenarios", reason: `they were saved in library format ${JSON.stringify(doc.version)}; this build reads ${LIBRARY_VERSION}` }], error: null };
  }
  const entries: LibraryEntry[] = [];
  const dropped: DroppedEntry[] = [];
  const droppedRaw: unknown[] = [];
  const ids = new Set<string>();
  doc.entries.forEach((raw, k) => {
    const reason = checkEntry(raw) ?? (ids.has((raw as LibraryEntry).id) ? "duplicate id" : null);
    if (reason) {
      dropped.push({ name: entryName(raw, k), reason });
      droppedRaw.push(raw);
      return;
    }
    const e = raw as unknown as LibraryEntry;
    ids.add(e.id);
    entries.push({ id: e.id, schemaVersion: e.schemaVersion, savedAt: typeof e.savedAt === "string" ? e.savedAt : "", scenario: e.scenario });
  });
  if (dropped.length > 0) {
    backupDropped(store, droppedRaw);
    saveLibrary(store, entries);
  }
  return { entries, dropped, error: null };
}

/** Drops entries whose scenario fails `invalid` (returns a reason, or null if fine), e.g. the JSON Schema. */
export function dropInvalid(store: KeyValueStore | null, entries: readonly LibraryEntry[], invalid: (s: Scenario) => string | null): { entries: LibraryEntry[]; dropped: DroppedEntry[] } {
  const keep: LibraryEntry[] = [];
  const dropped: DroppedEntry[] = [];
  const raws: unknown[] = [];
  for (const e of entries) {
    const reason = invalid(e.scenario);
    if (reason) {
      dropped.push({ name: e.scenario.name, reason });
      raws.push(e);
    } else keep.push(e);
  }
  if (store && dropped.length > 0) {
    backupDropped(store, raws);
    saveLibrary(store, keep);
  }
  return { entries: keep, dropped };
}

/** Writes the library; returns an error message instead of throwing (e.g. quota exceeded). */
export function saveLibrary(store: KeyValueStore | null, entries: readonly LibraryEntry[]): string | null {
  if (!store) return "This browser does not allow saving, so the change lasts only until the page is closed.";
  try {
    store.setItem(LIBRARY_KEY, JSON.stringify({ format: LIBRARY_FORMAT, version: LIBRARY_VERSION, entries }));
    return null;
  } catch (e) {
    return `Could not save: ${e instanceof Error ? e.message : String(e)}. The change lasts only until the page is closed.`;
  }
}

/** Adds or replaces the entry with the scenario's id. */
export function upsertEntry(entries: readonly LibraryEntry[], scenario: Scenario, now: Date): LibraryEntry[] {
  const id = scenario.id;
  if (!id) throw new Error("A saved scenario needs an id");
  const entry: LibraryEntry = { id, schemaVersion: scenario.schemaVersion, savedAt: now.toISOString(), scenario };
  const k = entries.findIndex((e) => e.id === id);
  if (k < 0) return [...entries, entry];
  const out = [...entries];
  out[k] = entry;
  return out;
}

export function removeEntry(entries: readonly LibraryEntry[], id: string): LibraryEntry[] {
  return entries.filter((e) => e.id !== id);
}
