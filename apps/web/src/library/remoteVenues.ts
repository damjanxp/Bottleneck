/**
 * Venues loaded from the server (a shared link, /v/{id}), next to the built-in examples. The page
 * opens at most one at a time. The catalogue (catalog.ts) reads this list, so a shared venue and
 * its scenarios appear in every section like an example does; components subscribe with
 * useRemoteVenues() so they re-render when it changes.
 */

import { useSyncExternalStore } from "react";
import type { Scenario, Venue } from "@bottleneck/schema";

export interface RemoteScenario {
  /** Server id (also the document's id). */
  id: string;
  scenario: Scenario;
  /** For If-Match on the next update. */
  etag: string | null;
}

export interface RemoteVenue {
  id: string;
  title: string;
  venue: Venue;
  scenarios: RemoteScenario[];
}

let current: readonly RemoteVenue[] = [];
const listeners = new Set<() => void>();

export function remoteVenues(): readonly RemoteVenue[] {
  return current;
}

export function setRemoteVenues(list: readonly RemoteVenue[]): void {
  current = list;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useRemoteVenues(): readonly RemoteVenue[] {
  return useSyncExternalStore(subscribe, remoteVenues, remoteVenues);
}
