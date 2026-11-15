/**
 * Undo and redo for the venue editor (review C4, D-066). The document is immutable: every edit
 * makes a new document that shares unchanged parts with the old one (structural sharing), and the
 * history keeps references to whole previous documents, never inverse commands. Undo therefore
 * returns exactly the earlier object, and a bug in one edit cannot corrupt the history.
 *
 * Dragging a point makes many tiny edits; edits with the same `coalesce` key in a row replace the
 * newest entry instead of adding one, so one drag is one undo step.
 *
 * Pure: no React, no storage.
 */

export interface History<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
  /** Key of the last edit, for coalescing; null after undo, redo or a non-coalescing edit. */
  readonly lastKey: string | null;
}

/** How many undo steps are kept (older ones are dropped). */
export const HISTORY_LIMIT = 200;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null };
}

/**
 * Records `next` as the new present. Returns the same history if `next` is the present object
 * (an edit that changed nothing). A new edit clears the redo list.
 */
export function commit<T>(h: History<T>, next: T, coalesce: string | null = null): History<T> {
  if (next === h.present) return h;
  if (coalesce !== null && coalesce === h.lastKey && h.past.length > 0) {
    return { past: h.past, present: next, future: [], lastKey: coalesce };
  }
  const past = h.past.length >= HISTORY_LIMIT ? [...h.past.slice(h.past.length - HISTORY_LIMIT + 1), h.present] : [...h.past, h.present];
  return { past, present: next, future: [], lastKey: coalesce };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0;
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0;
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const previous = h.past[h.past.length - 1] as T;
  return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future], lastKey: null };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const next = h.future[0] as T;
  return { past: [...h.past, h.present], present: next, future: h.future.slice(1), lastKey: null };
}
