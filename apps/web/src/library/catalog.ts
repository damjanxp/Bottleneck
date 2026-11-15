/** Every scenario the page can offer: the built-in examples, a shared venue's scenarios on the server, and the user's saved ones. */

import { exampleVenues } from "@bottleneck/examples";
import type { Scenario, Venue } from "@bottleneck/schema";
import { remoteVenues } from "./remoteVenues.ts";
import type { LibraryEntry } from "./storage.ts";

export interface ScenarioChoice {
  /** "builtin:<id>", "server:<id>" (a shared venue's scenario on the server) or "user:<id>". */
  key: string;
  label: string;
  venueId: string;
  scenario: Scenario;
  /** Read-only here: a built-in example, or a scenario stored on the server (changed through the Share section). */
  builtIn: boolean;
  description: string;
}

export const builtInKey = (id: string) => `builtin:${id}`;
export const userKey = (id: string) => `user:${id}`;
export const serverKey = (id: string) => `server:${id}`;

/** A venue the page can show: a built-in example or one loaded from the server. */
export interface KnownVenue {
  id: string;
  title: string;
  venue: Venue;
  remote: boolean;
}

export function knownVenues(): KnownVenue[] {
  return [...exampleVenues.map((v) => ({ id: v.id, title: v.title, venue: v.venue, remote: false })), ...remoteVenues().map((v) => ({ id: v.id, title: v.title, venue: v.venue, remote: true }))];
}

export function isRemoteVenue(id: string): boolean {
  return remoteVenues().some((v) => v.id === id);
}

export function venueTitle(id: string): string {
  return knownVenues().find((v) => v.id === id)?.title ?? id;
}

/** Built-in examples and, for a shared venue, its scenarios on the server: the read-only choices. */
export function builtInChoices(venueId?: string): ScenarioChoice[] {
  const examples = exampleVenues
    .filter((v) => venueId === undefined || v.id === venueId)
    .flatMap((v) => v.scenarioInfo.map((s) => ({ key: builtInKey(s.id), label: s.title, venueId: v.id, scenario: s.scenario, builtIn: true, description: s.description })));
  const server = remoteVenues()
    .filter((v) => venueId === undefined || v.id === venueId)
    .flatMap((v) => v.scenarios.map((s) => ({ key: serverKey(s.id), label: s.scenario.name, venueId: v.id, scenario: s.scenario, builtIn: true, description: "" })));
  return [...examples, ...server];
}

export function userChoices(entries: readonly LibraryEntry[], venueId?: string): ScenarioChoice[] {
  return entries
    .filter((e) => venueId === undefined || e.scenario.venueId === venueId)
    .map((e) => ({ key: userKey(e.id), label: e.scenario.name, venueId: e.scenario.venueId, scenario: e.scenario, builtIn: false, description: "" }));
}

export function allChoices(entries: readonly LibraryEntry[], venueId?: string): ScenarioChoice[] {
  return [...builtInChoices(venueId), ...userChoices(entries, venueId)];
}

export function findChoice(key: string, entries: readonly LibraryEntry[]): ScenarioChoice | undefined {
  return allChoices(entries).find((c) => c.key === key);
}

export function venueById(id: string): Venue | undefined {
  return knownVenues().find((v) => v.id === id)?.venue;
}

/** Ids in use by built-in and saved scenarios (an imported file must not reuse one). */
export function usedScenarioIds(entries: readonly LibraryEntry[]): Set<string> {
  return new Set([...builtInChoices().map((c) => c.scenario.id ?? ""), ...entries.map((e) => e.id)]);
}
