/**
 * Engine self-check: a fixed workload whose hash must be identical everywhere the engine runs.
 *
 * It exercises every determinism-sensitive part built so far: the counter-based random numbers,
 * ln/exp, the normal inverse CDF, and the event loop running a tiny single-lane queue. A Vitest
 * test pins the hash in Node; the web app computes it again in a Web Worker and shows whether it
 * matches. Phase 1 replaces the toy queue with a real scenario and checks it in CI with Playwright.
 *
 * If you change the engine on purpose and this hash changes, update EXPECTED_SELF_CHECK_HASH
 * and say why in the commit message.
 */

import { exp, ln } from "./detmath.ts";
import { normalInverseCdf, sampleExponential, sampleShiftedLognormal } from "./distributions.ts";
import { Float64Hasher } from "./hash.ts";
import { RandomStream, uniform } from "./rng.ts";
import { Simulation, type EventHandler } from "./simulation.ts";

export const EXPECTED_SELF_CHECK_HASH = "65c22d4016e96961";

const SEED = 20261111;
const ARRIVAL = 1;
const COMPLETION = 0; // completions before arrivals at the same instant

interface ToyState {
  queue: number[]; // ids of customers waiting
  busy: boolean;
  served: number;
}

export interface SelfCheckResult {
  hash: string;
  numbers: number;
  matches: boolean;
}

export function runSelfCheck(): SelfCheckResult {
  const hasher = new Float64Hasher();

  // 1. Random numbers and math functions.
  for (let i = 0; i < 2000; i++) {
    const u = uniform(SEED, RandomStream.SelfCheck, i % 7, i);
    hasher.add(u).add(ln(u)).add(exp(8 * u - 4)).add(normalInverseCdf(u));
  }

  // 2. A single-lane queue on the event loop: Poisson arrivals (mean gap 10 s), shifted
  //    lognormal service (about 8 s), 500 customers.
  const state: ToyState = { queue: [], busy: false, served: 0 };
  const customers = 500;

  const startService = (sim: Simulation<number>, id: number): void => {
    state.busy = true;
    const u = uniform(SEED, RandomStream.ScanTime, id, 0);
    const service = sampleShiftedLognormal(u, 2, 1.6, 0.5);
    hasher.add(sim.now).add(service);
    sim.schedule(sim.now + service, COMPLETION, 0, id);
  };

  const onArrival: EventHandler<number> = (event, sim) => {
    const id = event.payload;
    if (id + 1 < customers) {
      const gap = sampleExponential(uniform(SEED, RandomStream.ArrivalTime, id + 1, 0), 10);
      sim.schedule(sim.now + gap, ARRIVAL, 0, id + 1);
    }
    if (state.busy) state.queue.push(id);
    else startService(sim, id);
  };

  const onCompletion: EventHandler<number> = (_event, sim) => {
    state.served++;
    hasher.add(sim.now);
    const next = state.queue.shift();
    if (next === undefined) state.busy = false;
    else startService(sim, next);
  };

  const sim = new Simulation<number>(
    new Map([
      [ARRIVAL, onArrival],
      [COMPLETION, onCompletion],
    ]),
    [{ name: "sample", update: (s) => hasher.add(state.queue.length).add(s.now) }],
  );
  sim.schedule(0, ARRIVAL, 0, 0);
  while (state.served < customers) sim.step();
  hasher.add(sim.tick);

  const hash = hasher.digest();
  return { hash, numbers: hasher.size, matches: hash === EXPECTED_SELF_CHECK_HASH };
}
