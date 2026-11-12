/** Every scenario the page can offer: the built-in examples plus the user's saved ones. Pure. */

import { exampleVenues } from "@bottleneck/examples";
import type { Scenario, Venue } from "@bottleneck/schema";
import type { LibraryEntry } from "./storage.ts";

export interface ScenarioChoice {
  /** "builtin:<id>" or "user:<id>". */
  key: string;
  label: string;
  venueId: string;
  scenario: Scenario;
  builtIn: boolean;
  description: string;
}

export const builtInKey = (id: string) => `builtin:${id}`;
export const userKey = (id: string) => `user:${id}`;

export function builtInChoices(venueId?: string): ScenarioChoice[] {
  return exampleVenues
    .filter((v) => venueId === undefined || v.id === venueId)
    .flatMap((v) => v.scenarioInfo.map((s) => ({ key: builtInKey(s.id), label: s.title, venueId: v.id, scenario: s.scenario, builtIn: true, description: s.description })));
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
  return exampleVenues.find((v) => v.id === id)?.venue;
}

/** Ids in use by built-in and saved scenarios (an imported file must not reuse one). */
export function usedScenarioIds(entries: readonly LibraryEntry[]): Set<string> {
  return new Set([...builtInChoices().map((c) => c.scenario.id ?? ""), ...entries.map((e) => e.id)]);
}
