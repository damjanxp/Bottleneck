/**
 * What a comparison or batch runs: entries (scenarios), seeds, and the resulting list of jobs.
 *
 * Seeds: one seed per entry is just that scenario's own seed, unless "same seeds" is on (the
 * default), in which case every entry runs with the first entry's seed(s). Equal seeds mean
 * common random numbers (D-003): every person gets the same personal random numbers in every
 * scenario, so a difference comes from the change, not from luck. A batch of N seeds uses the base
 * seed plus N − 1 seeds derived from it by a fixed hash, so the set is reproducible.
 */

import { hash4 } from "@bottleneck/engine";
import type { Scenario } from "@bottleneck/schema";

export const MAX_ENTRIES = 4;
export const MAX_SEEDS = 5;
/** Stream number for seed derivation (any constant; unrelated to the engine's RandomStream values). */
const SEED_STREAM = 0x5eed;

export interface CompareEntry {
  /** Stable key, e.g. "builtin:concert-3-lanes", "user:user-…", "adhoc:3". */
  key: string;
  label: string;
  scenario: Scenario;
}

export interface Job {
  jobId: number;
  entryIndex: number;
  seedIndex: number;
  seed: number;
  scenario: Scenario;
}

/** Seeds of a batch: the base seed first, then N − 1 derived ones (uint32, deterministic, distinct). */
export function deriveSeeds(base: number, n: number): number[] {
  const seeds = [base >>> 0];
  for (let k = 1; seeds.length < n; k++) {
    const s = hash4(base >>> 0, SEED_STREAM, k, 0);
    if (!seeds.includes(s)) seeds.push(s);
  }
  return seeds.slice(0, Math.max(0, n));
}

/** Seeds per entry. With `sameSeeds`, every entry gets the first entry's set (paired comparison). */
export function seedsFor(entries: readonly CompareEntry[], seedCount: number, sameSeeds: boolean): number[][] {
  const n = Math.min(MAX_SEEDS, Math.max(1, Math.floor(seedCount)));
  const first = entries[0]?.scenario.seed ?? 1;
  return entries.map((e) => deriveSeeds(sameSeeds ? first : e.scenario.seed, n));
}

/** One job per (entry, seed), seed-major so the first results cover every entry early. */
export function planJobs(entries: readonly CompareEntry[], seedCount: number, sameSeeds: boolean): Job[] {
  const seeds = seedsFor(entries, seedCount, sameSeeds);
  const jobs: Job[] = [];
  const n = seeds[0]?.length ?? 0;
  for (let s = 0; s < n; s++) {
    entries.forEach((e, i) => {
      const seed = seeds[i]?.[s] as number;
      jobs.push({ jobId: jobs.length, entryIndex: i, seedIndex: s, seed, scenario: { ...e.scenario, seed } });
    });
  }
  return jobs;
}

/** Distinct venue ids of the entries (more than one means the numbers are not comparable). */
export function venueIds(entries: readonly CompareEntry[]): string[] {
  return [...new Set(entries.map((e) => e.scenario.venueId))].sort();
}
