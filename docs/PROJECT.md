# Bottleneck: project document

**The one place to check everything**: status, decisions, the acceptance checklist, each phase's plan and summary, and the "how it works" learning notes. It is updated at the start and end of every phase.

The specification it builds on lives next to it: [spec/Bottleneck-specification-v0.2.pdf](spec/Bottleneck-specification-v0.2.pdf) and the review notes [spec/keep-in-mind.md](spec/keep-in-mind.md). Where this document and the spec disagree, this document wins: every difference is recorded below as a decision.

| Section | What's in it |
|---|---|
| [1. Status](#1-status) | Where the project is right now, and what the owner needs to do |
| [2. Decisions](#2-decisions) | Every significant choice, including owner-approved changes to Fixed rules |
| [3. Review notes triage](#3-review-notes-triage) | What happened to each point in keep-in-mind.md |
| [4. Acceptance checklist](#4-acceptance-checklist) | Every check from spec section 9, re-sorted into the right phase, with status |
| [5. Fixed rules](#5-fixed-rules-consolidated) | All Fixed rules from the spec in one list, with how each is enforced |
| [6. Phases](#6-phases) | Plan and summary per phase |
| [7. How it works](#7-how-it-works-learning-notes) | Plain-language learning notes per phase, with interview questions |
| [8. Reference](#8-reference) | Repository layout and commands |

---

## 1. Status

_Last updated: 2026-11-13_

| | |
|---|---|
| **Current phase** | Phase 3: vehicles, parking and departures, **complete and merged into `main` locally** (engine, schema, examples and web view; see [section 6](#phase-3-vehicles-parking-and-departures)). Phases 0, 1 and 2 are merged into `main` and were pushed to GitHub on 2026-11-12. |
| **Next phase** | Phase 4: .NET backend and jobs |
| **Git state** | Phase 3 commits are **local only, not pushed** (`main` is ahead of `origin/main`): the owner pushes together with Claude. Until then GitHub CI and Vercel have not run on Phase 3; the same checks were run locally (`npm run check`: 263 tests; `npm run test:e2e`: 6 passed, 1 skipped). |
| **Live demo** | Vercel (the owner imported the repository on 2026-11-11); every push to `main` deploys |
| **CI** | GitHub Actions: schema check, lint, typecheck, unit and validation tests, build on every push; a second job runs the Playwright browser tests (Chromium) |
| **How the work is done** | Work is orchestrated with subagents: the main agent plans and reviews, and subagents do focused pieces (code, tests, docs). Everything lands on a `phase-N` branch and passes `npm run check` before merging. |

**What exists after Phase 2** (merged to `main`):
- **Pedestrian engine, examples, simulation view and Playwright tests** from Phase 1 (decisions D-014 to D-031).
- **Scenario library and editor** in the browser, validated against the JSON Schema (D-032, D-033); interactive lane failures (D-035).
- **Comparison and batches** in background workers with common random numbers and paired confidence intervals (D-034); `@bottleneck/analysis` (statistics and scan-log fitting).
- **Scan logs:** the engine's service log, CSV export, import, fit and apply (D-037 to D-039).
- **README with a GIF** (`docs/media/demo.gif`, `docs/media/screenshot.png`), recorded by `apps/web/e2e/record-demo.spec.ts` (skipped unless `RECORD_DEMO=1`).

**What exists after Phase 3** (merged to `main` locally, not pushed):
- **Schema:** roads, vehicle sources, vehicle barriers, parking lots and crossings in the venue; car parameters, departures and `lotClose` in the scenario (D-040).
- **Engine:** a road graph with routing, car-following, barriers on the shared lane core, parking with reservations, overflow rules, departures with an exit rush, and the parking metrics (D-041 to D-051).
- **Examples:** a stand-alone 320-stall car park (pay machines, or pay at the barrier, or pay at the barrier with 3 exit lanes) and car parks at Belgrade Fair (fair day with cars, a car park that closes, a concert with cars and departures, paying at the machines or at the barrier), with qualitative tests (D-052).
- **Web view:** cars, roads, lots, stalls, barriers, crossings and the public-road edge on the map; parking headline card, lot and barrier tables with charts; "Jump to departures" and "Close lot now"; car fields, departure curve, barrier and lot overrides in the scenario editor; parking rows in the comparison; a Playwright test of the car park example (D-053).

**Still open:** the owner's [human] checks (below), and pushing Phase 3 to GitHub together with the owner.

### What the owner needs to do now

1. **Live jam check** (Phase 1 [human]): after the merge, open the Vercel URL, press Play on the concert example and see a queue form within 2 minutes; confirm that the "Engine self-check" line says **✓ Match: bit-identical to Node**. Send me the URL and I will put it in the README (it currently says "link added after deployment check").
2. **`?perf=1` numbers** (Phase 1 [human]): on the machine you consider the reference machine, run with `?perf=1`, 8×, the concert example for about a minute, and send me frame p95, worker tick p95, CPU, browser and agent count.
3. **Confirm the README and the GIF** (Phase 2 [human]): look at `README.md` on GitHub and at `docs/media/demo.gif`; tell me if anything is unclear or wrong.
4. **Optional: upgrade Node.js** on your machine to 24 LTS (you have 20.19, which reached end of life in April 2026). Everything works on 20.19 for now, but some newer tools, such as Vitest 5, already require 22 or later.

---

## 2. Decisions

Each record has four short parts: context, decision, alternatives, consequences. Records that change a **Fixed** rule are marked **[owner-approved]**.

### D-001 One project document instead of many files
- **Context:** Spec section 11 asks for `docs/plans/phase-N.md`, `docs/decisions/NNN-*.md` and `docs/how-it-works/phase-N.md` (Fixed), which adds up to dozens of files.
- **Decision:** **[owner-approved, 2026-11-11]** Everything goes in this one document. Only `README.md` (for GitHub visitors) and `CLAUDE.md` (instructions for the coding agent) live separately.
- **Alternatives:** The spec's per-phase files; a docs site.
- **Consequences:** One long file, so sections are numbered and linked from the table at the top. The learning-notes content required by the spec is unchanged; only its location differs.

### D-002 Vite + React instead of Next.js
- **Context:** The app is static and client-only until Phase 4, and even then the .NET API is the backend. Next.js would run in "client components only, static export" mode, which uses almost none of what Next.js is for.
- **Decision:** Vite 8 + React 19 + TypeScript + Tailwind CSS 4.
- **Alternatives:** Next.js (more CV keyword value; adds an SSR framework the app does not use and makes the Web Worker and static export setup more awkward).
- **Consequences:** Simpler build, faster dev server, plain static output for Vercel. If routing is needed later (e.g. `/v/{id}` share links in Phase 4), a small client-side router is added.

### D-003 Counter-based randomness **[owner-approved, 2026-11-11]**
- **Context:** Spec 4.1 (Fixed) says "one documented seeded PRNG (sfc32 or mulberry32)". A single sequential generator breaks *common random numbers*: adding or failing a lane changes how many draws happen before agent 500's scan time, so every later number shifts and a "3 vs 5 lanes" comparison partly measures luck.
- **Decision:** Every random number is a pure function `uniform(seed, stream, entity, index)`: a 32-bit hash (four rounds of an invertible `lowbias32`-style mixer using `Math.imul`) mapped to (0, 1). `stream` says what the number is for (arrival time, scan time…; listed in `RandomStream`, never renumbered), `entity` is usually the agent id, `index` counts draws of that kind for that entity. Where practical, an agent's draws are made when it is created.
- **Alternatives:** One sfc32 stream (breaks CRN); one sfc32 per agent seeded from a hash (equivalent but needs per-agent state).
- **Consequences:** Two runs with the same seed give every agent the same personal numbers whatever else changes. Quality is checked by tests (avalanche, chi-square along each input, correlation of neighbours).

### D-004 Drain all due events inside a tick, in (time, kind, id) order **[owner-approved, 2026-11-11]**
- **Context:** Spec 4.1 (Fixed) fixes the per-tick order "due arrivals, due service completions, lane assignments, movement, density, metrics". If each event type is handled once per tick, a lane that finishes a 3.1 s service at t = 3.1 waits until the next tick to start the next person: up to 0.25 s idle per service. That breaks the D/D/1 and M/D/1 tolerances.
- **Decision:** Inside a tick, every event with time ≤ tick end is processed in strict (time, kind, id, insertion) order, including events created by other events in the same tick. A service starts at max(predecessor's completion, the moment the next person is ready at the head), not at the tick boundary. Then the tick systems run in the fixed order: lane assignment, movement, density, metric sampling. Shuffling forward in the queue line is visual only.
- **Alternatives:** The spec's grouped order (simpler, but lanes are idle by up to a tick).
- **Consequences:** Exact queueing behaviour, independent of the 0.25 s tick. At equal times, completions run before arrivals (a lane frees up before the next person arrives), so `kind` numbers will be: completion < timed scenario event < arrival. This is defined in Phase 1.

### D-005 Deterministic math: what "only + − × ÷ and sqrt" means
- **Context:** Spec 4.1 (Fixed) allows only + − × ÷ and `Math.sqrt` for engine arithmetic.
- **Decision:** Also allowed, because they are exact by definition and therefore identical in every engine: comparisons, `Math.floor/ceil/round/trunc/abs/min/max/sign`, integer and bit operations, `Math.imul`, and reading or writing a double's bits through a `DataView`. `ln` and `exp` are implemented in `detmath.ts` from those operations, and `powPositive(x, y) = exp(y·ln x)` is built on them. The normal distribution uses Acklam's inverse CDF (one uniform per draw, relative error < 1.15·10⁻⁹); the truncated normal uses rejection on the same entity's next indices. Trigonometry is avoided in the engine: directions are unit vectors, not angles.
- **Alternatives:** Lookup tables (less accurate, more memory); trusting `Math.exp`/`Math.log` (V8 in Node and Chrome usually agree, but nothing guarantees it).
- **Consequences:** ESLint blocks `Math.exp`, `Math.log`, `Math.pow`, `Math.sin`, `Math.random`, `Date.now` and others in `packages/engine/src`. `ln`/`exp` are within about 1 ulp of `Math.log`/`Math.exp` (tested) and their exact bits are pinned by a golden-hash test.

### D-006 Metrics hash over Float64 bytes
- **Context:** Invariant 1 compares a "hash of the metrics" between Node and Chrome. A JSON string could hide a difference in the last bits or invent one through number formatting.
- **Decision:** `Float64Hasher` hashes each number's exact 8 bytes (big-endian), after treating −0 as 0 and every NaN as one canonical NaN, into a 64-bit non-cryptographic hash shown as 16 hex digits. Metrics are fed in a documented, fixed order. The p95 statistic will use the nearest-rank definition (Phase 1).
- **Alternatives:** SHA-256 over JSON (slower, and still has the formatting problem); a cryptographic hash (unnecessary: there is no adversary).
- **Consequences:** The engine self-check hash `65c22d4016e96961` is pinned in Node by a test and recomputed in the browser's Web Worker on the live page.

### D-007 Schema design
- **Context:** Spec 8 (Fixed): formats written once as JSON Schema in `/schema`, with generated TypeScript (and later C#), a CI check that the generated code is current, and `schemaVersion` on every document.
- **Decision:**
  - JSON Schema **draft-07** (the best-supported draft across Ajv, json-schema-to-typescript and NJsonSchema for C#). Files: `common`, `venue`, `scenario`, `run`. Types are generated into `packages/schema/src/generated/types.ts` by `npm run schema:gen`, and checked by `npm run schema:check`.
  - **Lanes are a count, not individually drawn.** A gate group (or screening stage) is a line plus a `laneCount`; lanes are spaced evenly along the line. "3 lanes vs 5 lanes" is then a scenario override, not a geometry edit, and timed events address lanes as `(groupId, laneIndex)`.
  - **Times** are seconds relative to t = 0, where t = 0 is the event start for fixed-start events and the opening time for open-door events. `referenceClock` (e.g. "20:00") is display only. `timeline.horizon` ends the run, which then reports "not drained" if people are still outside (review B).
  - **Distributions** are tagged unions. The shifted lognormal stores `shift, mu, sigma` of the underlying normal, so E[S] and E[S²] are exact (needed for the Pollaczek–Khinchine test). Presets convert friendly numbers such as "2.5–7 s, mean 4 s" into these parameters.
  - Points are `{x, y}` objects in metres. y points down, like the background image.
  - Collections have `maxItems` caps now, so the Phase 4 jsonb limits already exist.
  - Vehicle elements (roads, barriers, lots, crossings) are added in Phase 3.
  - **Until Phase 4, the schema may change without migrations**, because nothing is stored on a server yet. Phase 2's localStorage entries carry `schemaVersion` and are dropped (with a notice) if incompatible. From Phase 4, every change bumps `schemaVersion` with a tested migration.
- **Alternatives:** Draft 2020-12 (weaker C# tooling); individually drawn lanes (makes lane-count comparisons need geometry edits).
- **Consequences:** `run.parameters` and `run.metrics` are open objects until Phase 1 defines them.

### D-008 Tooling versions
- **Context:** Tool versions as of November 2026.
- **Decision:** npm workspaces (no pnpm needed); TypeScript 6.0 (TypeScript 7, the native Go compiler, is not yet supported by typescript-eslint); Vitest 4.1 (Vitest 5 needs Node 22+); ESLint 10 with typescript-eslint; Ajv 8 for schema validation in tests; Node 24 in CI ("the CI version" for invariant 1), with Node ≥ 20.19 supported locally.
- **Consequences:** Revisit TypeScript 7 and Vitest 5 when the owner's machine is on Node 24 and typescript-eslint supports TS 7.

### D-009 Strict Content-Security-Policy from day one
- **Context:** Review D: XSS would let an attacker steal edit keys (Phase 4), so a strict CSP should be Fixed.
- **Decision:** `vercel.json` sends `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'…` plus `Referrer-Policy: no-referrer`, `nosniff`, `X-Frame-Options: DENY`. `vite preview` serves the same headers, so CSP breakage shows up locally. No inline scripts or styles are allowed. The app uses no cookies.
- **Alternatives:** Adding the CSP in Phase 4 (more painful to retrofit).
- **Consequences:** PixiJS (Phase 1) must work without `unsafe-eval`. PixiJS v8 does; this is verified when it is added.

### D-010 Engine purity is enforced by the compiler and the linter
- **Context:** Invariant 6: the engine depends on nothing from the DOM, the renderer or the network.
- **Decision:** `packages/engine/tsconfig.json` compiles with `lib: ["ES2023"]` and no `DOM` or Node types, so `document` or `window` do not even type-check. ESLint additionally bans browser and Node globals, Node built-in modules and UI packages inside `packages/engine/src`.
- **Consequences:** Invariant 6 has an automated check (lint and typecheck in CI) from Phase 0.

### D-011 Little's law includes the wait-so-far of people still queuing
- **Context:** Little's law says L = λ·W. A lane's reporting window ends at its last service start. If the lane is overloaded, people are still queuing at that moment, and their waiting has not been added to the sum of finished waits yet. Comparing only the finished waits with the queue length then fails for a definitional reason, not because anything is wrong.
- **Decision:** The core checks Little's law as two independent counts of the same person-seconds: (a) the time-integral of the queue length, and (b) the sum of all waits, where people still queuing at the window end contribute their wait so far. The relative difference is `littleLawError` in the lane metrics and must be about 0 (the test asserts under 10⁻⁹) for every lane, overloaded or not. The textbook form, mean queue = arrival rate × mean wait within 3%, is asserted only when the lane has drained (at most 2 people still queuing at the window end).
- **Alternatives:** Asserting the textbook form on every lane, including overloaded ones (fails by definition); dropping the check for overloaded lanes (loses the strongest bookkeeping test).
- **Consequences:** The check works on every lane of every run, including runs that end with a queue. The 3% textbook check still covers the drained case, which is the one a reader expects from the formula.

### D-012 The M/G/1 test runs 40 hours per seed
- **Context:** Review B6 asks that a statistical test pass only if the 95% confidence interval (CI) contains the theory **and** its half-width is under 3% of the theoretical value. With 20 seeds × 10 h, the M/G/1 wait at 80% utilisation with a lognormal tail is too noisy: the half-width stays above 3%.
- **Decision:** The M/G/1 Pollaczek–Khinchine test runs 40 simulated hours per seed (41 h in total, the first 1 h is warm-up and not counted), 20 pinned seeds, with the stricter two-part rule. The M/D/1 test keeps 10 h per seed (after a 1 h warm-up), because its service time never varies and it is much less noisy.
- **Alternatives:** Loosening the 3% rule (hides noise, which is what B6 forbids); more seeds (costs the same run time and the t-value changes).
- **Consequences:** The M/G/1 test is the slowest in the suite but still runs in CI in seconds, because the lane core is cheap.

### D-013 Lane behaviour: logical FIFO, readiness, failure and retry
- **Context:** Spec 4.1 and review B3 need queue waits that still count people who are queuing but not yet standing at the lane (spillback), plus lane failure and scan retries.
- **Decision:**
  - **Wait starts at commit.** A person joins the lane's FIFO (first in, first out) the moment it commits to the lane, wherever it stands. Wq runs from commit to service start.
  - **Service needs "ready".** A service starts at max(previous completion, the moment the head of the line is physically at the lane). `markReady` tells the core when a person arrives there.
  - **Lane failure:** the person already in service finishes. Everyone still queuing is handed back to the caller in arrival order, to be assigned as new lane-visits elsewhere (their time on the failed lane is dropped from both sides of Little's law, and their arrival there is not counted).
  - **Scan retry:** a failed scan keeps the lane busy for extra seconds, and the same person tries again.
  - **Second failure:** the person is rejected to the manual lane (the lane is freed, the person is not counted as served).
- **Alternatives:** Wait starts only when the person reaches the queue area (hides the cost of spillback, review B3); a lane failure that cancels the person in service (not physical).
- **Consequences:** The core only needs the number of lanes, a few callbacks and the simulation clock; the pedestrian world (milestone 1b) decides where people walk and which lane they choose.

### D-014 When a person is "ready", when they commit, and what is measured
- **Context:** D-013 says a service needs the person to be "ready" and that the wait starts at commit. Phase 1's pedestrian world has to say exactly when those two moments happen, because queue lengths and waits depend on them.
- **Decision:** A person **commits** to a lane (joins its logical FIFO) as soon as the walk to the nearest lane of the stage is at most the *decision distance* (20 m). The wait (`Wq`, per lane-visit) runs from that commit to the service start (B3). A person is **ready** only when they reach their *own slot* in the line (slot k is 0.6 m behind slot k − 1, slot 0 is the head). Moving up one slot when the person in front leaves is only visual: it never delays or speeds up a service, because the lane core only needs "is the head of the FIFO physically at its slot". The metrics also report `queueWait`: the time from physically joining the line to the service start. It is never longer than `Wq`, and the gap shows how much of the waiting happened while still walking towards the line.
- **Alternatives:** Commit at the lane itself (hides spillback, review B3); ready when the person in front has left (couples the lane core to the animation).
- **Consequences:** Waits include the walk from 20 m away, so even an empty lane has a small wait. `queueWait` is the "classic" queue time for anyone who prefers it. The 20 m is a parameter (`decisionDistance`, assumed).

### D-015 Manual lane per gate group after a second scan failure
- **Context:** Spec 5 says only that a person whose scan fails twice is "sent to a manual lane".
- **Decision:** Each gate group gets one extra lane, the *manual lane*, half a lane spacing beyond end `a` of the line, with the same queue geometry (`venueModel.ts`). Nobody chooses it: a person is sent there after their **second** failed scan, starts a new wait there, and is served with a uniform 20 to 40 s service time (assumed). It is marked `manual` in the metrics so charts can separate it, and it takes no part in capacity or jockeying.
- **Alternatives:** One manual lane for the whole venue (far away from most gates); a manual lane per regular lane (many more lanes to draw).
- **Consequences:** With a 3% scan failure rate, very few people end up there (two failures in a row), so it is rarely busy, but the long service time makes it a visible side queue when it is.

### D-016 Geometry conventions: the inside of a line, and translation invariance
- **Context:** Gate lines are drawn from point `a` to point `b`; the engine must know which side is "inside". Review B7 wants translating the venue to give bit-identical results.
- **Decision:** The **inside** of a line is the side where `cross(b − a, p − a) > 0` (in the y-down picture: the right-hand side when looking from `a` towards `b`). The engine works in *local* metres: venue metres minus the corner of the walkable areas' bounding box, **rounded to 1/1024 m**. The rounding absorbs the last-bit error of the subtraction (for example 5.1 − 0.1 is not exactly 5 in binary), so a translated venue produces exactly the same grid and the same numbers. 1/1024 m is about 1 mm, far below the 0.5 m grid.
- **Alternatives:** Compare with a tolerance (the test then proves less); exact integer coordinates in the schema (too restrictive for users).
- **Consequences:** The translation test asserts an identical metrics hash. Rescaling is different: it legitimately changes the grid, so it is tested statistically (mean over 20 paired seeds changes by less than 2%).

### D-017 Engine time zero, and lanes closed before the gates open
- **Context:** Scenario times are relative to the event start or the gates' opening (D-007), and people may arrive before the gates open (a queue forming outside a closed gate).
- **Decision:** **Engine time 0** is scenario time `timeOffset`: the scenario's `gatesOpen`, or, if anyone arrives (or a timed event happens) before the gates open, the earliest such time rounded down to a whole minute, minus one minute. `toScenarioTime()` converts back for display. All lanes are **closed before the gates open**: nobody is served, but people can already walk up, commit and queue. Opening the gates opens every lane that has not failed.
- **Alternatives:** Always start at `gatesOpen` (arrivals before it would be cut off); lanes open from the start (people would walk through closed gates).
- **Consequences:** The clock shown in the UI is scenario time, not engine time. A test covers an open-door event with arrivals before the gates open, and one checks that nobody is served before the gates open.

### D-018 Arrivals: a sorted pointer, and groups of 1 to 5 (review E3)
- **Context:** 10,000 people each have an arrival time. Checking all of them every tick would be wasteful, and review E3 says real arrivals come in groups, not one by one.
- **Decision:** At creation, every person gets an arrival time (inverse-CDF sampling of the scenario's arrival curve, counter-based randomness per D-003) and the people are put in one list **sorted by (arrival time, id)**. A pointer `nextArrival` moves forward through it, so each tick only looks at people who are due; the pointer is saved in checkpoints. People are created in **groups of consecutive ids**; group sizes 1 to 5 follow the default distribution **30%, 40%, 15%, 10%, 5%** (assumed; mean 2.2 people). A group shares its leader's arrival time and source, walks at its slowest member's speed, and the first member to decide at a stage picks the lane for the others (if it is still open and reachable). `groupSizes: [1]` switches groups off.
- **Alternatives:** Scanning every Pending person each tick; independent people (too smooth, review E3).
- **Consequences:** Arrival bursts of 2 to 5 people make queues a bit worse than independent arrivals at the same average rate, which is realistic. The example tuning (D-028) was redone with groups on.

### D-019 Spillback rows
- **Context:** When more people commit to a lane than its queue area (`queueLength` metres, 0.6 m per person) can hold, the rest must stand somewhere, still counted in that lane's FIFO.
- **Decision:** The first `capacity` slots are the queue line itself. Beyond them people stand **behind the queue area in rows**, `perRow` people side by side (the width of the lane's strip divided by the slot spacing), one row every 0.6 m, on walkable cells. They are physically "in the line": they count in the lane's committed total and its metrics, and are ready once they stand at their row position.
- **Alternatives:** Stop people at the queue area's end without rows (they would pile up in one spot, giving wrong densities); extend the queue area indefinitely (walks into walls).
- **Consequences:** Spillback raises the density near the gate, which slows people through the Weidmann relation (see the learning notes), so jams feed themselves, as in reality.

### D-020 Lane choice: nearest-lane share, logit with τ = 15 s, deterministic reassignment after a failure
- **Context:** Spec 4.2 asks for lane choice that is neither "everyone takes the closest" nor "everyone takes the shortest queue".
- **Decision:** With probability `nearestLaneShare` (0.3) a person takes the open lane with the shortest walk. Otherwise they choose by **logit**: P(lane) ∝ exp(−cost/τ), with cost = walk time + (people committed to the lane, including the one in service) × the stage's mean service time, and **τ = `logitScale` = 15 s** (a lane that costs 15 s more is e times less likely). Commitment is immediate, so the next person in the same tick already sees the new count; the random draw comes from the person's own counter-based stream. When a lane fails (timed `laneFail`), the person in service finishes and the queue is **reassigned in arrival order**, each person to the open lane of the same element with the lowest walk time plus expected wait (or any element of the same stage set if all are failed), keeping their wait clock running.
- **Alternatives:** Pure nearest lane (no balancing); pure shortest queue (everyone switches at once, unrealistically); random reassignment (unnecessary: a deterministic order is enough).
- **Consequences:** `nearestLaneShare`, `logitScale` and the decision distance are parameters stored with every run (F7). The numbers are assumptions, not measurements.

### D-021 Jockeying rule
- **Context:** Spec 4.2 mentions people switching to a faster lane.
- **Decision:** A queued person may jockey **at most once per stage**, only if they are standing at the line (in the queue area or spilled back behind it), only to a lane of the **same element**, only if that lane has at least **3 fewer** people than are ahead of them (`jockeyThreshold`), and they go to the **back** of the new lane. Among equal lanes the one nearest to the current lane wins. The lane core removes them from the old FIFO with `LaneBank.withdraw`, which keeps Little's law exact (tested).
- **Alternatives:** No jockeying (queues never balance); unlimited jockeying (people ping-pong).
- **Consequences:** Jockeying moves a few people per jam, enough to even out lanes without changing the picture. It is on the cut list (F2 in section 3) if time runs out.

### D-022 TurnedAway means "unreachable" in Phase 1, and `carShare` is ignored until Phase 3 (superseded by D-046)
- **Context:** The state enum has `TurnedAway` for cars rejected at a full lot (Phase 3). The scenario schema also has `carShare`.
- **Decision:** In Phase 1 a person is `TurnedAway` only if their source has **no walking path** to a lane; the run counts them as `unreachable` and the example tests require 0. `carShare` is **accepted and stored but ignored** by the engine until vehicles exist (Phase 3): everyone arrives on foot.
- **Alternatives:** Reject scenarios with `carShare > 0` (would block the schema); silently drop people (breaks conservation).
- **Consequences:** `unreachable` is a venue-editing safety net (Phase 5 validation will flag it earlier). The examples use `carShare: 0`.

### D-023 Deadlock watchdog
- **Context:** A run that cannot finish (every lane failed, a person stuck) would otherwise run to the horizon (review B5).
- **Decision:** If there are active people (not Pending, not Inside, not TurnedAway), the gates are open, no scheduled lane reopening is pending, and **nothing has changed for 10 simulated minutes** (`watchdogMinutes`), the run stops with `deadlock: true`. A run also stops when everyone is Inside or TurnedAway (`drained: true`) or when it reaches `timeline.horizon` (`drained: false`).
- **Alternatives:** Only the horizon (slow, and unclear why it ended); a wall-clock timeout (breaks determinism).
- **Consequences:** The result states why a run ended. The example tests require `drained: true` and `deadlock: false`.

### D-024 Service-time presets: bag policy (E4) and the card/QR mixture (E2)
- **Context:** Reviews E2 and E4 say a single 4 s turnstile time is too slow, and that screening time depends on the bag policy.
- **Decision:** A new `mixture` distribution (a weighted choice between component distributions, with **exact** E[S] and E[S²] computed from the components, so Pollaczek–Khinchine checks still work). The turnstile default is a 50/50 mixture of **card** (at least 2 s, mean 3 s) and **QR** (at least 2.5 s, mean 4.5 s), both shifted lognormal with σ = 0.5, so the mean is 3.75 s. The bag policy sets the default screening time (shifted lognormals, assumed): **none** (minimum 1.5 s, mean 2.5 s), **clear bag** (minimum 2 s, mean 4 s), **full search** (minimum 4 s, mean 10 s, σ = 0.6). A venue element's own `serviceTime` still wins over the policy. Presets are built from friendly numbers by `shiftedLognormalFromMean(min, mean, sigma)`.
- **Alternatives:** One distribution with a heavy tail (hides the two real populations); bag policy as free text.
- **Consequences:** Defaults are scenario `parameters`, resolved and stored in the run record (F7), so users can override them. The mixture picks its component with the last random index of each draw, so counter-based randomness (D-003) is kept.

### D-025 Metrics: capacity versus peak demand, "below 85%", and the outside-at-start split (review E1)
- **Context:** Review E1 wants capacity in people per hour next to peak demand, the first time utilisation falls under 85%, and a clearer "who is still outside at the start".
- **Decision:** Per element: **capacity** = regular lanes × 3600 / mean busy time per person; **peak demand** = the busiest 60 minutes of people choosing the element, with its start time; **utilisation** per 60 s bin = busy time / open time of the regular lanes; the **peak** and the **"below 85%" time** use windows of 5 bins, so one quiet minute does not count, and `below85At` is null if utilisation never reached 85%. Venue-wide, for fixed-start events, `stillOutsideAtStart` is split into **arrived but outside** (they were at the venue and not yet through the gate) and **not yet arrived** (late arrivals); both are null for open-door events. Lane metrics are also reported separately for services **before and after the start**.
- **Alternatives:** One "still outside" number (mixes lateness with queuing); per-minute utilisation (too noisy).
- **Consequences:** The UI can say "capacity X per hour against a peak demand of Y per hour" instead of only "long queues". The examples test asserts that for the 3-lane concert demand is above capacity.

### D-026 Checkpoints for replay (review C1)
- **Context:** Storing every snapshot for replay would pass 200 MB; running from 0 for every backward seek is slow.
- **Decision:** `run.saveCheckpoint()` copies every piece of dynamic state into typed arrays (about 165 bytes per agent plus lane histories and the density grid). `restoreRun()` rebuilds the static parts from the venue and scenario and continues **bit-identically** (tested: the same metrics hash as the uninterrupted run; a checkpoint from another scenario is refused). The worker (`apps/web/src/sim/checkpoints.ts`) keeps one every few simulated minutes under a 64 MB budget: the interval is chosen at load (at least 1 minute, whole minutes), and if the budget is still exceeded every other checkpoint is dropped and the interval doubles. A seek restores the best checkpoint and steps forward, and can be cancelled.
- **Alternatives:** Snapshots of all agents 20 times per second (memory); re-running from 0 (a seek to the end of a 2.5 h run would be slow).
- **Consequences:** A checkpoint is about 1 MB at 4,500 people and about 2 MB at 10,000. A backward seek costs about 0.3 s (mostly rebuilding the flow fields) plus at most one interval of stepping.

### D-027 Performance work with identical results
- **Context:** The first working version spent most of its time on things that are almost entirely empty or very regular.
- **Decision:** Three changes, each proven by an unchanged metrics hash: (1) **sparse density**: the density grid smooths and divides only the 3 × 3 neighbourhoods of occupied 2 m cells (every other cell has exactly 0 in every term); (2) **bucket-queue flow fields** (Dial's algorithm): Dijkstra with buckets 0.5 m wide instead of a binary heap, giving the same distances bit for bit; (3) an **active-agent list**: the per-tick systems only visit agents that are on the move or in a line, not those still Pending or already Inside.
- **Alternatives:** A coarser grid (changes results); approximate flow fields (changes results).
- **Consequences:** Runs became about 5 times faster with identical numbers. See the measured numbers in [section 6](#phase-1-pedestrian-simulation). `EXPECTED_SELF_CHECK_HASH` did not change.

### D-028 How the examples were tuned (and why they differ from the spec's defaults)
- **Context:** The examples must show a clear difference ("3 lanes jam, 5 lanes cope"), and the tests assert it with margin, but the numbers must stay believable and assumed values must be labelled.
- **Decision:**
  - **Concert:** 4,500 people, gates open 90 minutes before the start. Arrivals use a **custom curve** (not the generic concert preset) with about **2% arriving after the start**. 3 lanes (about 2,700 people/h) are overloaded, 5 lanes (about 4,500/h) are not. After groups became the default, the final round lowered the late surge (weight 1.2 to 0.9 at 7.5 minutes before the start, 0.5 to 0.3 at the start, and the tail after the start lengthened from 5 to 8 minutes to keep its 2% share), because "3 lanes leaves more than 5 times as many people outside at the start as 5 lanes" had only 6% headroom (1,330 against 252). Now it is 1,312 against 177 (7.4 times).
  - **Bag check:** the example uses a **fast check at the screening stage (minimum 2 s, mean 3 s)**, not the spec's 12 s. At 12 s the bag check alone would need roughly ten lanes for 4,500 people, so every turnstile lane count would jam at the screening and the 3-versus-5 comparison would show nothing. A slow check is available as the bag policy `fullSearch` (D-024) for Phase 2's scenario comparison.
  - **Fair day:** 4,000 visitors over two hours, three gate groups (4, 5 and 6 lanes); arrival shares 70% tram stop, 10% bus stop, 20% street entrance (the tram stop is the closest to gate A, so reducing gate A matters). The bus burst adds a full tram of 1,800 and a bus load of 1,200 half an hour after opening (it was 1,500 and 1,000, with only 23% headroom on the p95 assertion).
  - The example tests (`exampleRuns.test.ts`) assert every ratio with at least 30% headroom; `EXAMPLE_RUNS_VERBOSE=1` prints the numbers.
- **Alternatives:** The spec's 12 s bag check (see above); weaker assertions (loses the point of the test).
- **Consequences:** A future change that makes groups, lane choice or movement slower may need the examples retuned; the failing assertion says which one moved.

### D-029 Worker protocol: Transferable double-buffered snapshots, drop instead of queue
- **Context:** The engine runs in a Web Worker (F1, F15) and the renderer on the main thread needs about 20 position updates per second for 4,500 to 10,000 people (F5).
- **Decision:** `workerProtocol.ts` defines every message. The worker owns **two Float32Array buffers** laid out as a structure of arrays (x, y, vx, vy, state; `SnapshotField` in `run.ts`) and posts one snapshot per 50 ms loop while playing as a **Transferable** (moved, not copied; no SharedArrayBuffer, which would need cross-origin isolation headers). The main thread hands a buffer back with `returnBuffer` once a newer snapshot has arrived. **If no buffer is free when a snapshot is due, the worker drops that snapshot** instead of queuing it, so a slow renderer never makes the worker fall behind or memory grow. Playback uses `PlaybackPacer` and a per-loop work budget of 40 ms: ticks beyond it are dropped (the run plays slower than asked, the results are unchanged). Snapshots carry velocity so the renderer can extrapolate between snapshots (review C3). Stats (state counts, lane queues, tick timing) go every 4th loop and metrics every 20th.
- **Alternatives:** `postMessage` with copies (garbage and copy cost); SharedArrayBuffer (headers and browser restrictions); a queue of snapshots (latency grows under load).
- **Consequences:** The UI never freezes (F15). A `generation` number on every message lets the page ignore messages from an earlier scenario.

### D-030 PixiJS under the strict CSP
- **Context:** D-009 forbids `unsafe-eval`, inline styles and `blob:` workers. PixiJS v8 normally generates shader and particle code at run time with `new Function`.
- **Decision:** `VenueRenderer.ts` imports **`pixi.js/unsafe-eval`**, an add-on whose polyfills replace the run-time code generation, so the page keeps its strict CSP. It uses **no `Assets` loader** (it spins up `blob:` workers, which the CSP forbids; textures are cut from one atlas instead) and **no `HTMLText`** (it injects `<style>`). People are drawn with one `ParticleContainer`, from a texture atlas holding one shape and colour per state. Rendering is on demand: continuously while playing, otherwise only when something changed.
- **Alternatives:** Relaxing the CSP with `unsafe-eval` (the thing D-009 wanted to avoid); Canvas 2D (too slow at 10,000 agents).
- **Consequences:** The Playwright smoke test (D-031) fails on any CSP violation or console error, so this cannot silently regress.

### D-031 Playwright setup
- **Context:** Invariant 1 (Node and Chrome give identical metrics) and the CSP-clean page need a real browser.
- **Decision:** `playwright.config.ts` runs Chromium against the **production build served by `vite preview`** (port 4173), which sends the same CSP as Vercel; `webServer` runs `npm run build && npm run preview`. **`workers: 1`**: the smoke test is CPU-heavy (software WebGL), and running beside another browser makes it flaky; CI allows one retry. The two tests are in `apps/web/e2e`. **`determinism.spec.ts`** runs a tiny pinned scenario (`apps/web/src/determinism/tinyScenario.ts`, imported by both sides) in Node and, through the `?determinism=1` page hook, in the built app's worker, and requires equal metrics hashes. **`smoke.spec.ts`** loads the concert example, sets speed 60×, presses Play, waits for the clock to advance, then uses **"Jump to peak"** (an exact seek in the worker) instead of waiting for the crowd in real time (**seek-based**, because headless Chrome renders slowly), and checks that people are queuing or inside, that the self-check says "bit-identical to Node", and that there are no alerts, console errors or CSP violations. CI has a separate `e2e` job (`npm run test:e2e`); the tests are not part of `npm run check`.
- **Alternatives:** Running the dev server (a different CSP); waiting for the crowd in real time (slow, flaky); several browsers in parallel.
- **Consequences:** `npm run check` stays fast and needs no browser; the e2e job is the only place Node and Chromium are compared.

### D-032 Scenario library in localStorage: one versioned key, dropped entries kept as a backup
- **Context:** Phase 2 needs user scenarios before there is a backend (review A6). localStorage can be disabled, full or hold data from an older build.
- **Decision:** One key, `bottleneck.scenarios.v1`, holds `{ format: "bottleneck-scenario-library", version: 1, entries: [{ id, schemaVersion, savedAt, scenario }] }` (`apps/web/src/library/storage.ts`). Every entry carries its scenario's `schemaVersion`. On load, entries with another schema version, a broken shape or a duplicate id are dropped; once the validator chunk has loaded, entries that fail the JSON Schema are dropped too. Each drop shows a notice with the name and reason, and the raw entry is first copied to `bottleneck.scenarios.v1.dropped` (last 50), so nothing disappears silently. Every storage access is in try/catch; a failed save says so and the change lives until the page closes. Built-in examples are read-only: "Duplicate" makes an editable copy. Export and import use the plain scenario document (valid against `/schema/scenario.schema.json`) as a `.scenario.json` file; an imported file whose id is taken gets a new id.
- **Alternatives:** IndexedDB (async API, more code, no need at this size); one key per scenario (no atomic rewrite, harder to version); migrating old entries (D-007: no migrations before Phase 4).
- **Consequences:** Saved scenarios are per browser and per device until Phase 4. The format version and the schema version are separate, so a schema bump drops only the entries it affects.

### D-033 JSON Schema validation in the browser: Ajv standalone code generated at build time
- **Context:** Scenarios must be validated against the JSON Schema before saving or importing. Ajv compiles a schema with `new Function`, which the strict CSP (no `unsafe-eval`, D-009) forbids.
- **Decision:** Ajv's **standalone** mode runs the compilation at build time: a small Vite plugin (`apps/web/vite.config.ts`) serves the virtual module `virtual:scenario-validator`, built by `apps/web/src/validation/buildValidator.ts` from `/schema/common` and `/schema/scenario`. The one runtime helper it needs (`ucs2length`) is inlined, and the build fails if the code still needs `require` or code generation. The app loads it lazily (a 65 kB chunk, 7 kB gzipped) when saving, importing or checking stored entries. On top of the schema, `library/validate.ts` checks what the schema cannot see (element ids, lane numbers against the lane count, sources, timeline order) and turns everything into plain sentences. The editor's own fields are parsed by `library/form.ts` with messages per field.
- **Tests:** Vitest checks that the generated validator accepts and rejects the same documents as Ajv itself, that every built-in scenario round-trips through the editor form unchanged, and that every kind of editor output is schema-valid (`library.test.ts`).
- **Alternatives:** Hand-written validation only (drifts from the schema); Ajv at run time with `unsafe-eval` (weakens the CSP); a committed generated file (needs a freshness check; the build-time plugin cannot go stale).
- **Consequences:** The browser and (from Phase 4) the backend validate against the same schema files. Changing `/schema` changes the validator on the next build with no extra step.

### D-034 Comparisons and batches: background workers, common random numbers, paired confidence intervals
- **Context:** Spec 6.3 asks for up to four scenarios side by side and client-side batches of up to 5 seeds, with clear differences in words.
- **Decision:** A separate batch worker (`batch.worker.ts`) runs one scenario to the end in 100 ms chunks (so Cancel gets through) and returns the metrics; a pool of up to 4 workers (cores − 1) runs the jobs (`compare/runPool.ts`), so the simulation on screen is never disturbed. By default every scenario runs with the **first scenario's seeds** (common random numbers, D-003). A batch uses the base seed plus N − 1 seeds derived with `hash4(base, 0x5eed, k, 0)`, so the set is reproducible. Each headline number is shown as mean ± 95% CI (Student t, `summarise` from `@bottleneck/analysis`). With shared seeds the verdict comes from the **paired** per-seed differences: "better"/"worse" only if their 95% CI excludes 0, otherwise "no clear difference". With one seed the verdict is the sign of the difference (a person, half a second or 0.05 points count as "no change"). Verdicts are written out ("✓ better", "✗ worse"), never colour alone. Scenarios of different venues can be compared but get a clear warning.
- **Alternatives:** Running comparisons in the playback worker (blocks the simulation); independent seeds per scenario (much noisier differences).
- **Consequences:** On the development machine 2 concert runs take about 2.3 s and a 5-seed batch about 6.3 s in the browser (4 workers). The Playwright test asserts that the numbers on the page equal a Node run.

### D-035 Interactive lane failures are timed events in a working copy (review B8)
- **Context:** Failing a lane by clicking during playback must keep replays and comparisons exact.
- **Decision:** "Fail lane now" / "Reopen lane now" (for a lane selected on the map or in the lane table) adds a `laneFail`/`laneReopen` timed event at the current scenario time to a **working copy** of the scenario. The worker swaps in the working copy (`replaceScenario`), drops its checkpoints (they do not contain the new event) and re-runs from 0 to the current time as a normal, cancellable seek; playback resumes if it was playing. The saved scenario changes only if the user saves ("Save into this scenario" for their own, "Save as a new scenario" always); "Compare with the original" opens the comparison.
- **Alternatives:** Injecting the failure into the live run (the run would no longer be reproducible from its scenario); keeping old checkpoints (they would restore the old event list).
- **Consequences:** Applying a lane event late in a run costs a re-run up to that moment (a few seconds at the end of the concert). Manual lanes cannot be failed (they are not addressable by timed events).

### D-036 Web app structure for Phase 2: sections, and logic apart from presentation
- **Context:** The owner will redesign the whole frontend after the last phase.
- **Decision:** The page has four sections (Simulate, Scenarios, Compare, Scan logs) that stay mounted once visited, so their state survives switching; leaving Simulate pauses playback. All logic is in pure TypeScript modules with Vitest tests: `library/` (storage, form, validation, files, catalogue), `compare/` (seeds and jobs, measures and differences in words, table rows, chart data), `scanlog/` (applying a fit). React components only lay things out; shared class strings are in `ui/styles.ts` and the text in `strings.ts` (sentences built by the pure modules, such as difference sentences and validation messages, live with them). The Phase 1 "+1 lane" mini-comparison is gone: "+1 lane" now opens the comparison of the current scenario against the same with one more lane (review A9).
- **Consequences:** A redesign can replace the components without touching the tested logic.

### D-037 The engine's service log: every attempt, outside the metrics hash
- **Context:** Scan-log tools (Phase 2) need what a real system would record: one row per scan attempt. The engine already knows every attempt, but adding them to the metrics would change `metricsHash`.
- **Decision:** `run.serviceLog()` returns every service attempt (including failed scans, manual-lane services and rejections) in time order. It is **not part of `metricsHash`** (so no existing hash changes) and **is included in checkpoints**, so a restored run reports the same log as an uninterrupted one.
- **Alternatives:** Reconstructing the log from lane metrics (loses individual attempts); hashing it (changes every pinned hash for no benefit).
- **Consequences:** The log grows with the run (one row per attempt); it is read only when exported.

### D-038 Scan-log format: CSV with `time,seconds,lane,event`
- **Context:** Real scan logs are tabular and usually carry a clock time; the importer must accept what the generator writes, and the format should open in a spreadsheet.
- **Decision:** CSV with the header `time,seconds,lane,event`. `seconds` is **scenario time** (relative to the start, as in the schema); `time` is **HH:MM:SS.sss** from the scenario's `referenceClock`, wrapped at 24 h. `lane` is 1-based and named `gate-main#2`, and the manual lane of an element is `<element>#manual`. `event` is one of `scan_ok`, `scan_fail`, `manual_ok`, `rejected`.
- **Alternatives:** JSON (harder to open in a spreadsheet); one row per visit (hides retries, which are exactly what real logs show).
- **Consequences:** A log from a real system only needs these four columns to be imported.

### D-039 Fitting a scan log: busy-period inter-departure intervals
- **Context:** A log gives only the moments of events, not how long each scan took. The service time must be estimated from the gaps between consecutive events on a lane, but a gap is a service time only if the lane was busy during it.
- **Decision:**
  - **Departures** are the rows that end a visit: `scan_ok`, `manual_ok` and `rejected`. A failed scan and its retry are therefore one visit, and the fitted service time is the **busy time per visit** (it includes the retry).
  - **Idle-gap rule:** within a group of lanes, a gap between two departures of the same lane counts as **busy** if it is at most **3 × the group's pooled median inter-departure gap**. The first departure after an idle gap gives no interval, and neither does each lane's first departure.
  - **Groups:** the lanes of one element form a group; manual lanes are **their own group**.
  - **Arrivals** are estimated from the first attempts per time bin, with weights relative to the busiest bin, at most 200 points.
  - **Bias:** a slight underestimate for long services (a gap longer than 3 × median is treated as idle), and biased high for groups that are never busy (every gap is then an inter-arrival time).
  - **Result:** on `concert-5-lanes` the fitted mean is **4.42 s against the true 4.31 s (+2.7%)**. The acceptance test requires recovery within 10% (`packages/analysis/test`).
  - `summarise` (mean and 95% CI) uses an **exact Student-t table for df 1 to 30** and 1.96 beyond.
- **Alternatives:** Using all gaps (dominated by idle time at quiet lanes); assuming a distribution family up front (the fit would then test the assumption instead of the data).
- **Consequences:** The fit needs busy lanes; on a quiet lane it overstates the service time. The test uses the busy 5-lane concert, which is the intended use.

### D-040 Schema additions for vehicles, and the shared enums
- **Context:** D-007 left room for the vehicle elements. The browser validator (D-033) builds only `common` and `scenario`, and the venue schema is not loaded there.
- **Decision:** The venue gets five optional collections:
  - `roads`: a polyline, `direction` (`oneWay` or `twoWay`), `laneCount` per direction, `freeSpeed` (km/h, default 25), `publicRoad`.
  - `vehicleSources`: a point on a road, a `share`, optionally a `lotId`.
  - `vehicleBarriers`: a road, a position on it, `kind` (entry or exit), `laneCount`, `serviceType` (ticket, plate, card, payAtBarrier), an optional `serviceTime` and `misread`.
  - `parkingLots`: an outline, `stallRows` (a line, a count, a side) and single `stalls`, `aisles`, the entry and exit barrier ids, `walkingExit`, an optional `payStation`, `stallChoice` (nearestEntry or nearestWalkingExit), `overflow` (queue, divert with `divertTo`, or leave) and `paymentMode` (payStation, payAtBarrier or prepaid).
  - `crossings`: a segment across a road or aisle, with a width.
  The scenario gets `departures` (a demand curve), the car parameters, and the timed event `lotClose`. Scenario `overrides` can now also change a barrier's `serviceType` and a lot's `paymentMode`, `stallChoice` and `overflow`. The enums these use (`BarrierServiceType`, `StallChoice`, `OverflowRule`, `PaymentMode`) live in `common.schema.json`, because the browser validator builds only `common` and `scenario`, and `scenario` needs them for overrides.
- **Scenario parameters (all assumed, all stored with every run):** `occupancy` 0.35 / 0.35 / 0.18 / 0.12 for cars of 1 to 4 people (mean about 2.1), `cardShare` 0.7, `carExitDelay` 20 s (from parking to getting out), `carBoardDelay` 20 s (from everyone aboard to the car leaving), `carLength` 4.5 m, `carGap` 2.5 m, `aisleSpeed` 8 km/h, `parkManoeuvre` 6 s (the time a car blocks an aisle turning into or out of a stall).
- **Departure presets** are relative to `eventEnd`: concert (−10 min to +50 min, peak 5 min after the end), stadium (about 85% within 20 minutes of the final whistle), fair (the last three hours of opening), conference (the last hour).
- **Alternatives:** Putting the new enums in `venue.schema.json` (the browser could not validate overrides); a separate vehicle schema file.
- **Consequences:** Still no migrations before Phase 4. The generated types were regenerated (`npm run schema:gen`) and checked by `schema:check`.

### D-041 The road graph: cut at ends and junctions, all-pairs quickest routes
- **Context:** Cars need a network to route on. Venue authors draw roads and aisles as polylines, and should not have to draw junction nodes.
- **Decision:** `roadNetwork.ts` builds a directed graph of **edges** (one per road segment between junctions, with a lane count). Roads and aisles are **cut where an end point meets another road's end point, and at T-junctions**: where an end point lies within 1 m of another road's line. Barriers also cut the road: the last 30 m before a barrier become its own **approach edge** (D-044). Routing is **all pairs**: the quickest travel time (length / free speed, aisles at the aisle speed) from every edge to every other, computed once, with **deterministic tie-breaking** (lowest edge id first). A car's route is therefore a table lookup.
- **Alternatives:** Routing per car with A* (more work per car, same answers); asking the author to draw nodes.
- **Consequences:** A car that cannot reach any lot (a road that does not connect) is turned away and counted, so a badly connected venue shows up as a lot with no parked cars; the venue editor will flag it (Phase 5).

### D-042 Car-following: ordered lanes, free speed, no overtaking
- **Context:** The cars need to queue believably, and a full traffic model (acceleration, lane changes) would cost a lot for little insight into bottlenecks.
- **Decision:** Every edge lane keeps its cars **in order, front first**. Each 0.25 s tick a car moves at its edge's **free speed**, but never closer than **carLength + carGap (7 m)** behind the car in front, never past a stop line it must obey (a barrier it has not been served at, its target, a crossing with a pedestrian on it), and never onto the next edge if that edge lane has no room. **There is no overtaking within a lane, and speed changes are instant** (no acceleration).
- **Alternatives:** Intelligent-driver or Gipps models (more parameters, no new insight for queue lengths); cars as pedestrians (wrong geometry).
- **Consequences:** A queue of cars moves up as a block with a speed that is a bit optimistic. The effect on a barrier's capacity is made explicit in D-044.

### D-043 Spillback and reservations (B5)
- **Context:** Review B5: cars must not be able to gridlock, and a full car park must not trap cars inside.
- **Decision:**
  - **Road space:** an edge lane has a storage of **length / 7 m** cars (at least 1). A car enters an edge lane only if it holds fewer cars than that and the last car there is far enough ahead; from that moment the space is the car's.
  - **Stalls:** a car **reserves its stall when it is admitted to the barrier approach**, before it is served at the entry barrier. **A barrier serves only a car that holds a stall**, so no car is ever inside a lot without one and the aisles cannot gridlock with cars looking for space.
- **Alternatives:** Letting cars search for a free stall inside the lot (can deadlock when the lot is full); reserving at the barrier (cars already in the approach would then wait with no stall).
- **Consequences:** A full lot shows up as an entry queue or an overflow rule (D-045), never as a jam inside. Stall search time is the driving time from the barrier to the reserved stall.

### D-044 Barriers on the shared lane core
- **Context:** A barrier is a lane that serves one car at a time. It should have the same queueing logic (and the same checks) as a turnstile.
- **Decision:**
  - Barrier lanes live in the **same `LaneBank`** as the pedestrian lanes (ids after the pedestrian lanes), so Little's law, the service log and the exact-time events work unchanged.
  - **The last 30 m before a barrier** are cut off as its approach edge and **widened to the barrier's lane count**.
  - A car **commits to the lane with the fewest committed cars (among those with room) when it enters the approach**, and stays in it. That moment is the **start of Wq** (B3). It is **ready** at the stop line, and at an entry also holds a stall.
  - A **plate misread** (default 5%, assumed) sends the car through the fallback time (15 to 30 s) instead of the normal one: a retry, as with a failed scan.
  - **Capacity is about 1 / (s + 1.25 s)**, not 1 / s, because moving up to the stop line after a car has left adds about 1.25 s to every service.
  - Default service times (assumed): entry ticket 5 to 10 s, plate or card 4 to 8 s, exit 4 to 8 s, pay at the barrier a card/cash mix (card 15 to 25 s, cash 25 to 45 s), pay station a card/cash mix on foot (card 20 to 35 s, cash 35 to 60 s) (E5, D-049).
- **Alternatives:** A separate barrier model (duplicates the checks); letting a car pick a lane at the stop line (hides the queue for the lane, review B3).
- **Consequences:** The capacity of a barrier lane is below 1 / s. The comparison test (D-050) uses this.

### D-045 Overflow: queue, divert once, leave (A3)
- **Context:** Review A3: what does a car do when the lot is full, and is `Diverted` a state or a counter?
- **Decision:** When a car reaches the approach of a lot that is full (no free stall) or closed (`lotClose`, which makes the lot act as full) it applies the lot's rule:
  - **queue:** the car is admitted without a stall and waits at the barrier until a stall frees up;
  - **divert:** the car drives on to the lot `divertTo` and is **Diverted** while it does; **a second full lot turns it away** (`TurnedAway`), so a car is redirected at most once;
  - **leave:** the car is `TurnedAway` and disappears from the road where it is.
- **Alternatives:** Unlimited diverting (cars could circle forever); queueing as the only rule.
- **Consequences:** The lot metrics report `turnedAway`, `divertedAway` and `divertedIn` per lot. A lot with the queue rule and no departures can never serve its waiting cars, so the run ends by the watchdog with `deadlock: true` (D-048); this is tested.

### D-046 Cars and people are counted separately (A4)
- **Context:** Review A4: occupants created at parking time would break conservation.
- **Decision:**
  - **Separate counts:** `carCountsByState` has the states Pending, Driving, Diverted, Parked, Departed and TurnedAway for cars; `countsByState` is for people. Each sums to its own total at every tick.
  - **Occupants are drawn at creation:** if the venue has roads, a vehicle source and a lot, the first `round(carShare × attendance)` people come by car, as **consecutive ids**, one car per run of 1 to 4 people (the occupancy distribution). They are **Pending** while in the car, until `carExitDelay` after parking.
  - **After parking** they walk **straight, off the walking grid**, to the lot's walking exit, and from there they are pedestrians like everyone else (through the gates, or to a destination if the venue has no gates).
  - **Turned-away cars:** their occupants are `TurnedAway` (people who never arrive), **not** counted as `unreachable`.
  - **`carShare` stays required.** `CAR_SHARE_DEFAULTS` (fair 0.55, concert 0.35, stadium 0.30, conference 0.40, review E4, assumed) is exported for editors to suggest; the engine uses the scenario's number and **ignores it if the venue has no roads, no vehicle source or no lot** (D-022 is therefore no longer true for venues with cars).
- **Alternatives:** Creating people when the car parks (conservation test would have to special-case them); a counter instead of a state for `Diverted`.
- **Consequences:** People and cars can be checked for conservation independently (tested on every example run).

### D-047 Departures: the exit rush
- **Context:** Spec 4.4: people leave in a wave after the event, and the car park's exit is where it jams.
- **Decision:** Only a scenario with a **departures curve** simulates departures; without it the run ends when everyone is inside. Each group (and each car's occupants) draws **one** departure time. Whoever is inside by then leaves; whoever is not leaves as soon as they get in. **People on foot** walk back to the source they came from, cross the gate lines **without being scanned** (the lanes are just points on the grid), and are Departed there. **Car users** walk to their lot's walking exit and straight on to their car; the **driver pays at the pay station** first if the lot's payment mode is `payStation`. Once everyone is aboard the car leaves **`carBoardDelay`** later, chooses the **lowest-cost exit barrier** (driving time plus expected queue), drives through it, and then to the **nearest road end**. Pay stations are pedestrian lane elements that reuse the gate machinery, and are **closed until the gates open**, like gates.
- **Alternatives:** Everyone leaves at the end time (no curve); scanning people on their way out (the gates are one-way turnstiles).
- **Consequences:** The exit queue and the time to empty are results of the scenario, not of a fixed rule.

### D-048 End of a run with cars: drained, the watchdog, crossings and measuring a queue
- **Context:** D-023 defined the end of a pedestrian run; cars and departures need the same.
- **Decision:**
  - **Drained** means: without departures, every person is Inside or TurnedAway and every car is Parked or TurnedAway; with departures, every person and every car is Departed or TurnedAway.
  - **The watchdog** counts moving or queued cars as active, in addition to walking or queuing people, and still waits while a gate opening, a timed event or a departure is yet to come.
  - **Crossings:** cars stop before a crossing while a pedestrian is on it; pedestrians wait while a stopped car stands across it. Cars and people therefore never occupy it together (tested tick by tick on the stand-alone car park, and with a forced stop in the engine tests).
  - **Queue measurement:** every tick, the cars that are heading for a barrier and are held up (moved less than half their free distance because of the car in front, the stop line or a full next edge) are candidates. Sorted by driving distance to the stop line, the queue is **the unbroken chain from the stop line backwards; it ends at the first gap of more than 1.5 car spacings**, so a car held up somewhere else does not count. Its length is the distance to the back of the last car in the chain, **extended by the cars waiting at a source only if the chain reaches that source**. The reported mean is over the window in which the barrier's lanes were open. A car of the chain on a road marked `publicRoad` means **the queue has reached the public road**, and the time is recorded.
- **Alternatives:** Measuring the queue as all slow cars (counts unrelated slowdowns); counting only cars at the stop line.
- **Consequences:** Queue lengths are comparable between scenarios. Numbers of cars are reported next to metres.

### D-049 Payment defaults (E5) and the plate-recognition finding
- **Context:** Review E5: payment times that are the same for everyone are pessimistic; card is faster than cash. Spec 6.5 expects plate recognition to beat tickets.
- **Decision:** Pay stations and pay-at-barrier exits use a **card/cash mixture** with `cardShare` 0.7 (D-040, D-044), built from the existing mixture distribution (D-024), so E[S] and E[S²] stay exact.
- **Finding, plate recognition is not always better:** the plate default (4 to 8 s, plus 5% misreads at 15 to 30 s) has a lower mean than the ticket default (5 to 10 s): **7.1 against 7.5 s**. But the misreads add a heavy tail, so its **second moment is larger**, and by the Pollaczek-Khinchine formula the wait depends on E[S²] (section 7). Plate recognition therefore **wins clearly only close to the barrier's capacity**; in a quiet hour the two are the same. And with a **6 s parking manoeuvre in a single aisle, the aisle becomes the bottleneck** before the entry barrier does. That is why `parkManoeuvre` is a scenario parameter, and why the plate-versus-ticket test uses 1 s (D-050).
- **Alternatives:** Making plate recognition faster to get the "expected" result (would hide the second-moment effect).
- **Consequences:** The numbers are assumptions: a venue with a real plate system should fit its own misread rate and fallback time.

### D-050 How the Phase 3 tests are set up, and what they found
- **Context:** The Phase 3 acceptance checks (section 4) each need a setup that isolates one effect.
- **Decision:**
  - **Plate against ticket:** 10 paired seeds (common random numbers), a lot whose entry barrier is the bottleneck, `parkManoeuvre` 1 s, and the paired difference of the mean entry queue with its 95% CI.
  - **Time to empty:** N = 60 cars, a single exit lane with service time s = 12 s, departures all at once; time to empty is at least N·s = 720 s and within 10% of N·s plus walking and driving time. Measured **849 s**, which is within 2.3% of the expected **about 869 s** (the exit capacity is 1 / (s + 1.25 s), D-044).
  - **Overflow:** one test each for leave, divert, queue (with departures), queue without departures (deadlock), and `lotClose`.
  - **Conservation** and **Little's law** are checked on every example run, including barrier and pay-machine lanes.
  - **Determinism:** the same seed gives the same hash, translating the venue gives a bit-identical one, and checkpoints restore bit-identically during arrivals, the show and departures.
- **Finding, what decides the time to empty:** when drivers **pay at machines**, the time to empty mostly follows the **departure curve** (and the machines); when they **pay at the barrier**, the **exit lanes** matter, because every car then spends 25 to 45 s at the lane. The examples show both (section 6).
- **Consequences:** A change to car behaviour that moves these numbers fails a test with a message saying which one.

### D-051 Metrics added for parking and departures
- **Decision:** `metrics.parking` has, per lot, the stall count, cars parked, the maximum occupancy and an occupancy series, the mean search time, `turnedAway`, `divertedAway`, `divertedIn`, when it closed, when it emptied and the **time to empty** (from the event end); per barrier the maximum and mean queue (metres and cars) and when the queue reached the public road; and the barrier lanes' own metrics (the same fields as a pedestrian lane). `metrics.departures` has the number of people and cars that departed and the first and last departure times. They enter the metrics hash only if the run has departures or the venue has a parking lot, so a venue without cars hashes exactly the numbers it did before. A venue with a lot hashes the (empty) parking block even with a car share of 0, so the hashes of the six Phase 1 scenarios changed when the Belgrade Fair venues got car parks (D-052); their numbers did not.
- **Consequences:** `run.schema.json` allows the new metric groups; the example runs are validated against it.

### D-052 Belgrade Fair car parks, and how the examples keep their old outcomes
- **Context:** Spec 6.1 lists "car parks with barriers" for the fair day and an exit rush after the concert. The existing scenarios have `carShare` 0 and their outcomes are asserted.
- **Decision:**
  - **Venues:** the fair-day venue gets two 480-stall car parks beside the forecourt, **north** (pay at the exit barrier, 3 exit lanes, overflow diverts to the south one) and **south** (pay machines, 2 exit lanes, overflow diverts to the north one), each with two entry roads, an exit road and a zebra crossing where the walkway crosses the exit road. The concert venue gets one 640-stall car park south of the forecourt (10 pay machines, 3 exit lanes, overflow: leave). All roads connect to **Bulevar vojvode Misica** (a two-way public road). The geometry is hand-drawn, inspired by OpenStreetMap, not exact.
  - **Scenarios:** only **new** scenarios use cars; the existing six keep `carShare` 0.
  - **The existing outcomes are unchanged.** The venues grew (new walkways, roads), but the new walkways are only joined to the forecourt, the bounding box of the walkable areas changed only by whole metres, and the pedestrian metrics of the six scenarios are **identical to the last bit**; only their metrics hash differs, because a venue with a lot now hashes a parking block (D-051). Nothing pins those hashes (the browser tests compare Node and Chrome on the same scenario, not against a stored value).
  - **New scenarios:** `fair-day-with-cars` (55% by car), `fair-day-north-car-park-closes` (`lotClose` at 30 minutes), `concert-cars-pay-station` (35% by car, 5 gate lanes, departures by the concert preset), `concert-cars-pay-at-barrier` (the same, paying at the exit barrier).
  - **Tests:** the same file as the Phase 1 examples (`exampleRuns.test.ts`): conservation of people and cars, no unreachable people, no deadlock, drained, cars parked, a visible exit queue after the concert, time to empty reported, and the comparison of the two payment modes, each with margins of at least about 30%.
- **Alternatives:** Changing the existing scenarios to use cars (would change asserted outcomes); a separate venue for the car examples (the spec wants the car parks at the Fair).
- **Consequences:** The fair day and the concert are now venues with cars; whether to show them is the web view's choice (a scenario without a car share looks as before).

### D-053 The web view of cars and parking
- **Context:** Phase 3's engine produces cars, lots, barriers and departures; the browser must show them without slowing the pedestrian view, and within the strict CSP. The frontend will be redesigned later, so the aim is clear and working, not polished.
- **Decision:**
  - **Data path:** the worker sends people and cars as a **pair** of Float32Array snapshots (`{people, cars}`), double-buffered; if no pair is free, the snapshot is dropped, never queued (D-029 now covers the pair). A venue without cars sends a zero-length car buffer, which is copied instead of transferred. The load message adds `vehicleCount`, `vehicleLayout` and `departurePeakStart`; stats add car counts and live barrier and lot states.
  - **Car markers:** four styles that differ in **shape as well as colour**: driving (arrow nose), standing (a driving car below 0.3 m/s; square front with a pause mark), parked (grey), diverted (arrow with a stripe). Pending, Departed and TurnedAway cars are not drawn; people inside a car are not drawn either. A stall shows as taken when a parked car stands on it (the engine has no per-stall state).
  - **Phases on the clock:** "Departures" starts at the first point of the departure curve that has weight; "Jump to departures" seeks to the busiest 15 minutes of that curve.
  - **"Close lot now"** records a `lotClose` timed event in the working copy and replays exactly up to now, like the interactive lane failures (D-035).
  - **Headlines:** time until empty is that of the slowest lot that had cars. On a venue without gates or screening (the stand-alone car park), the pedestrian headlines and comparison rows are hidden, because "650 people still outside" would be meaningless there.
  - **Comparison:** all car measures are lower-is-better; yes/no measures ("reached the public road") show the share of seeds.
  - **Editor:** a barrier's misread % is written as the override `scanFailureRate`; every new editor field produces schema-valid scenarios.
  - **Scan logs:** the export leaves out barrier lanes (`scanLogFromRun` uses only `run.lanes`); pay-station services appear as `scan_ok` rows.
- **Alternatives:** One combined snapshot array (would change the people layout the existing code relies on); drawing every stall's state (needs engine support for little gain before the redesign).
- **Consequences:** Known gaps, left for the redesign or later: with `carShare` 0 a venue's roads and lots are not drawn (the engine's vehicle layout is null then); the live barrier queue in metres comes from the metrics about once a second; barriers have no failed state; roads have no lane dividers; pay stations have no rows in the editor's element table; the comparison does not overlay lot occupancy across scenarios; the "+1 lane" button also appears for pay machines.

---

## 3. Review notes triage

What happened to each point in [keep-in-mind.md](spec/keep-in-mind.md). "Adopt" means it will be done as suggested; the phase is where.

| # | Point (short) | Decision | Where |
|---|---|---|---|
| A1 | Fixed rules scattered across sections | **Adopt**: consolidated list in [section 5](#5-fixed-rules-consolidated) | done |
| A2 | Not every invariant can be a pure [test] | **Adopt**: section 5 marks each rule [test], [lint] or [human] | done |
| A3 | `Diverted`: state or counter? | **Adopt**: a car may be redirected **once** (counted as an event); if the second lot is also full it becomes `TurnedAway`. `Diverted` stays in the enum as the state of a car driving to its second lot. | **done in Phase 3** (D-045; tests: divert, `lotClose`, `fair-day-north-car-park-closes`) |
| A4 | Occupants created at parking break conservation | **Adopt**: occupants are drawn when the car is created and held as `Pending` until they get out | **done in Phase 3** (D-046; people and cars each conserved at every tick) |
| A5 | Phase tests listed under the wrong phase | **Adopt**: re-sorted in [section 4](#4-acceptance-checklist) | done |
| A6 | Scenarios before the backend; timed failures need the timeline; roads before the editor | **Adopt**: localStorage plus JSON export/import (Phase 2); timed lane failure is scenario data from Phase 1; Phase 3 roads are hand-written JSON | Phases 1–2 done (D-032, D-033); roads in Phase 3 |
| A7 | 20k+5k vs 10k+2k agents | **Adopt**: 20,000 pedestrians + 5,000 cars is the **soft cap** (warning in the UI); 10,000 + 2,000 is the **performance reference** scenario | Phase 1 |
| A8 | Performance target is Expected but gates a [human] check | **Adopt**: the [human] check *reports* the measured numbers; missing the target is recorded with a plan and does not block the phase | Phase 1/3 |
| A9 | "Jam within 2 minutes" unrealistic at 1× | **Adopt**: examples open at 30×, with a "Jump to peak" button, a callout on the worst lane and a one-click "+1 lane" that opens the comparison | done: Phase 1 (30×, Jump to peak, worst lane); Phase 2 "+1 lane" opens the comparison (D-036) |
| B1 | Shared PRNG breaks common random numbers | **Adopt**: D-003 | done |
| B2 | Lanes idle up to 0.25 s per service | **Adopt**: D-004 | done |
| B3 | Wq starts only when joining the queue area | **Adopt**: a logical FIFO per lane begins when the agent **commits** to the lane (wherever it is standing); Wq, L and λ are measured per lane-visit, and spilled-back agents count | done in Phase 1 (D-014, D-019; `queueWait` is also reported) |
| B4 | Weidmann divides by zero / freezes at ρmax | **Adopt**: v = v₀ below ρ = 0.1 /m², and a floor of 0.1·v₀ | done in Phase 1 (`density.ts`, tested in `runParts.test.ts`) |
| B5 | Run end and "time until empty" when overloaded | **Adopt**: `timeline.horizon`, a `drained` flag, and a deadlock watchdog; cars reserve road space or a stall before entering | **done**: Phase 1 (`horizon`, `drained`, watchdog: D-023); Phase 3 cars (reservations D-043, end of a run D-048) |
| B6 | Test criteria that pass for the wrong reason | **Adopt**: M/D/1 and M/G/1 pass only if the 95% CI from 20 seeds contains the theoretical value **and** the CI half-width is under 3% of it; P-K uses the implemented E[S] and E[S²]; seeds pinned; setups stated (lane-failure test: about 85% utilisation before the failure); queue length excludes the person in service | Phase 1 done (`queueing.test.ts`, D-012); Phase 3: paired seeds and a CI that excludes 0 for plate against ticket (D-050) |
| B7 | Rescale check too noisy on one seed | **Adopt**: rescaling is checked on the mean of 20 paired seeds; translation must be bit-identical, with the raster anchored to the venue's bounding box | done in Phase 1 (D-016; `run.test.ts`) |
| B8 | Hash JSON vs bytes; p95 definition; interactive failures | **Adopt**: D-006 for the hash; p95 by nearest rank; interactive lane failures are recorded as timestamped scenario events, so replay by re-running stays exact | done: Phase 1 (D-006; timed lane events are scenario data); Phase 2 interactive "fail lane now" (D-035) |
| C1 | Replay memory blows 200 MB | **Adopt**: adaptive keyframe interval plus engine checkpoints every few simulated minutes; backward seeks restore the nearest checkpoint and re-run, cancellably | done in Phase 1: checkpoint interval adapts to a 64 MB budget, cancellable seeks (D-026) |
| C2 | Budget the worker tick separately | **Adopt**: worker tick p95 under 12 ms at the reference load, shown in `?perf=1` | done in Phase 1 (worker tick timing in the `?perf=1` overlay; numbers in section 6) |
| C3 | 20 Hz snapshots too coarse at 8× | **Adopt**: snapshots carry velocity; the renderer extrapolates | done in Phase 1 (D-029) |
| C4 | Undo: inverse commands vs immutable documents | **Adopt**: undo stores previous document references (cheap with structural sharing), not inverse commands | Phase 5 |
| C5 | Next.js adds little | **Adopt**: D-002 | done |
| C6 | Accessibility and mobile | **Adopt**: table alternatives for charts, keyboard-accessible editor tools, `aria-live` headline number, canvas hidden by default below about 768 px | Phase 1 partly done (`aria-live` headline number); table alternatives for charts and the mobile canvas rule still open |
| D1 | Limit the job runner | **Adopt**: one job at a time, per-venue and global queue caps, work budget (seeds × points × simulated hours), per-run timeout, jobs need the edit key | Phase 4 |
| D2 | .NET to Node contract | **Adopt**: a stateless internal HTTP sidecar; the database is the real queue (`Channel<T>` only wakes the runner); unique (venueId, requestId); Running→Queued on startup; `engineVersion` stored per result | Phase 4 |
| D3 | CSP, constant-time compare, atomic key rotation, no cookies | **Adopt**: CSP already in place (D-009); the rest in Phase 4 | Phases 0, 4 |
| D4 | Rate limits behind Caddy | **Adopt**: forwarded headers configured; concrete limits and global caps written down in Phase 4 | Phase 4 |
| D5 | Upload pixel caps, jsonb caps, validate around migrations, ImageSharp licence | **Adopt**; the licence is checked before use (fallback: SkiaSharp) | Phase 4 |
| D6 | Backups RPO/RTO, encryption, include uploads | **Adopt** | Phase 4 |
| D7 | README: .NET is orchestration and persistence | **Adopt** | Phase 4/6 |
| E1 | Capacity in people/hour next to peak demand; first time under 85% utilisation | **Adopt** | done in Phase 1 (D-025) |
| E2 | Turnstile 4 s is slow: card 3 s vs QR 4.5 s, 50/50 | **Adopt** as the new assumed default (mixed distribution) | done in Phase 1 (D-024) |
| E3 | Arrivals too smooth: groups of 1–5, late tail | **Adopt**: groups choose the same lane; concert preset gets ~20% of arrivals in the last 15 min | done in Phase 1 (D-018; the concert example uses its own curve, D-028) |
| E4 | Bag-policy field; car share per preset | **Adopt**: bag policy (none / clear bag / full search) sets screening time (Phase 1); car share fair 55%, concert 35%, stadium 30% (Phase 3) | **done**: bag policy in Phase 1 (D-024); car share defaults exported as `CAR_SHARE_DEFAULTS` in Phase 3 (D-046) |
| E5 | Payment defaults pessimistic | **Adopt**: card/cash mix for pay-at-barrier and pay stations | **done in Phase 3** (D-044, D-049) |
| E6 | "Latest gate opening for 95% inside" first in comparison | **Adopt** once sweeps exist | Phase 4 |
| E7 | README: replace defaults with measured throughput | **Adopt** | Phase 6 |
| F1 | Too many documents | **Replaced** by D-001 (one document) | done |
| F2 | Cut order if time runs out | **Adopt**: Phase 8 → Phase 7 → heatmap and scrubber → jockeying and logit choice → editor extras → VPS backups | always |

---

## 4. Acceptance checklist

Every check from spec section 9, sorted into the phase where the work actually happens (review A5). In the spec PDF most lists sit one phase too late. [test] = an automated test in CI; [human] = the owner checks it by looking.

### Phase 0: Foundation
- [x] [test] Random numbers are a pure function of (seed, stream, entity, index) and pass quality tests: avalanche, chi-square, correlation (`packages/engine/test/rng.test.ts`)
- [x] [test] Tick loop: fixed 0.25 s tick, drift-free clock, events at exact times, chained events drained within a tick, systems run in order after events (`simulation.test.ts`)
- [x] [test] Deterministic `ln`/`exp` within about 1 ulp of `Math.log`/`Math.exp`, with exact bits pinned (`detmath.test.ts`)
- [x] [test] Engine self-check hash pinned in Node (`hash.test.ts`)
- [x] [test] Generated schema types are up to date (`npm run schema:check` in CI)
- [x] [test] Valid fixtures pass and invalid fixtures fail schema validation (`packages/schema/test/schema.test.ts`)
- [x] [lint] Engine purity and determinism: no DOM, Node, clock, `Math.random` or non-exact `Math` functions in the engine
- [ ] [human] **An empty page is live on free static hosting**: the Vercel URL shows "✓ Match: bit-identical to Node"

### Phase 1: Pedestrian simulation on a built-in venue
- [x] [test] Two runs with the same seed give identical output; a different seed gives a different one (`packages/engine/test/run.test.ts`)
- [x] [test] The same tiny scenario gives the same metrics hash in Node and in Chrome's Web Worker (Playwright, `apps/web/e2e/determinism.spec.ts`, CI job `e2e`)
- [x] [test] D/D/1: at 80% utilisation the queue stays 0; at 125% the queue at time t equals (λ − μ)·t ± 1 (`packages/engine/test/queueing.test.ts`)
- [x] [test] M/D/1 at 70% utilisation, Poisson arrivals injected at one lane, 20 pinned seeds × 10 h after a 1 h warm-up: the 95% CI of mean Lq contains the theoretical 0.817 and its half-width is under 3% of it (`queueing.test.ts`)
- [x] [test] M/G/1 with the implemented scan-time distribution at 80% utilisation: mean Wq matches Pollaczek–Khinchine using that distribution's E[S] and E[S²], by the same rule (40 h per seed, see D-012; `queueing.test.ts`)
- [x] [test] Little's law and conservation on every lane and snapshot: on the lane core (D-011, `queueing.test.ts`), on a fixture run (`run.test.ts`) and on every example scenario (`packages/examples/test/exampleRuns.test.ts`: states always sum to the agents created, no deadlock, nobody unreachable, every run drained)
- [x] [test] Failing 2 of 4 lanes 30 min before the start (about 85% utilisation beforehand, pinned seed) raises the remaining lanes' maximum queue by at least 30% compared with the same seed without the failure (`run.test.ts`, "lane failure"). The example `concert-lane-fails` also shows it at venue level.
- [x] [test] Translating the venue gives bit-identical metrics; rescaling by 1.01 changes the mean p95 wait over 20 paired seeds by less than 2% (`run.test.ts`, "geometry invariance")
- [ ] [human] **The performance target in 7.2 is measured on the reference machine** (10,000 pedestrians at 8×: frame p95 < 33 ms, worker tick p95 < 12 ms), and the numbers are recorded. *What to look at:* open the live page (or `npm run build && npm run preview`) with `?perf=1` on the machine you consider the reference machine, load the concert example, set the speed to 8×, press Play and let it run for about a minute. The overlay shows **frame p95** (target under 33 ms) and **worker tick p95** (target under 12 ms). Send me both numbers, the machine (CPU, browser) and the agent count. Our own measurements so far are in [section 6](#phase-1-pedestrian-simulation): the worker tick is far below the target; the frame time on your machine is the part we have not seen. Missing the target does not block the phase (review A8); it gets a plan.
- [ ] [human] **The live demo loads the concert example and a jam forms within 2 minutes of pressing Play.** *What to look at:* open the Vercel URL. The concert example is loaded and the speed starts at 30× (review A9). Press Play and watch for 2 minutes of real time. People (small shapes) walk towards the gates; orange squares are people in a queue, and the side panel's lane queue numbers should grow, with the worst lane named in the callout. If nothing has formed after 2 minutes, or the page feels stuck, tell me; the "Jump to peak" button should take you to the busiest hour at once.

### Phase 2: Scenarios and comparison
- [x] [test] Comparing 3 vs 5 lanes on the concert example shows highlighted differences (Playwright, `apps/web/e2e/compare.spec.ts`: both runs in background workers, "better" rows for still-outside-at-start and p95 wait, numbers equal to a Node run, and "worse" when the order is swapped)
- [x] [test] A generated scan log, re-imported, recovers the mean scan time within 10% (`packages/analysis/test`; `concert-5-lanes`: fitted 4.42 s against true 4.31 s, +2.7%, D-039)
- [ ] [human] README with a GIF, the live link and the how-it-works notes. **First CV milestone.** *Ready for owner review:* `README.md` has the GIF (`docs/media/demo.gif`) and the status; the live link reads "link added after deployment check" until the Vercel URL is confirmed; the how-it-works notes are in [section 7](#7-how-it-works-learning-notes).

### Phase 3: Vehicles and parking
- [x] [test] A parked car produces exactly its occupant count as pedestrians (`packages/engine/test/vehicles.test.ts`, "cars become people")
- [x] [test] Over 10 paired seeds, plate recognition gives a lower mean entry queue than ticket entry, and the 95% CI of the paired difference excludes 0: **mean entry queue 60.98 m (ticket) against 40.81 m (plate), paired difference 20.16 ± 8.64 m** (`vehicles.test.ts`; setup and the finding behind it in D-049, D-050)
- [x] [test] Departure with N cars and one exit lane as the bottleneck (service time s): time to empty is at least N·s and within 10% of N·s plus walking and driving time: **N = 60, s = 12 s: 849 s, which is at least 720 s and within 2.3% of the expected about 869 s** (`vehicles.test.ts`, "departures")
- [x] [test] A full lot applies its overflow rule; turned-away cars are counted; conservation holds: leave, divert (once), queue with departures, queue without departures (deadlock) and `lotClose` each have a test (`vehicles.test.ts`, "overflow rules"); on the examples, `fair-day-north-car-park-closes` shows divert and turn-away at fair scale (`exampleRuns.test.ts`)
- [x] [test] An entry queue reaching the public-road boundary is recorded with its time (`vehicles.test.ts`; on the stand-alone car park the entry queues reach the main road during the arrival peak, `carParkExample.test.ts`)
- [x] [test] Little's law and conservation hold for barriers, pay stations and cars too: Little's law below 1e-9 on every barrier and pay-machine lane, and people and cars each conserved at every tick, on the stand-alone car park (every tick) and on every example run
- [x] [test] Checkpoints restore bit-identically with vehicles, translating the venue gives a bit-identical hash (`vehicles.test.ts`, "determinism with cars")
- [x] [test] Belgrade Fair with car parks: conservation, no unreachable people, no deadlock, drained, cars parked, a visible exit queue after the concert, time to empty reported, pay at the machines against pay at the barrier (`exampleRuns.test.ts`)
- [ ] [human] **The performance target with vehicles is measured on the reference machine** (10,000 pedestrians and 2,000 cars). Our own numbers (Node, development machine): tick mean 2.07 ms, p95 5.52 ms, of which the vehicle step p95 is about 0.4 ms (section 6). The frame time in the browser is the part we have not seen, like the Phase 1 item above.
- [x] [test] Web view of cars and parking: the car park example loads, cars drive and park, "Jump to departures" shows cars leaving, and after running to the end the time until empty and the longest exit queue equal a Node run; charts open; no console or CSP errors (`apps/web/e2e/parking.spec.ts`, D-053)

### Phase 4: .NET backend and jobs
- [ ] [test] Integration tests (Testcontainers): a missing or wrong edit key is rejected; rotating the key invalidates the old one; concurrent updates are detected
- [ ] [test] A 20-seed batch returns mean and 95% CI; a job can be cancelled; a queued job survives an API restart
- [ ] [test] A lane sweep on the concert example returns the smallest lane count that meets the target wait
- [ ] [test] A job run and a browser run with the same seed produce the same metrics hash
- [ ] [test] A wrong file type or oversized image is rejected; exceeding a rate limit returns 429
- [ ] [human] The app is live on the VPS over HTTPS; one backup restore has been tested. **Second CV milestone.**

### Phase 5: Venue editor
- [ ] [test] After two-click calibration, a 100 m distance measures 100 m ± 1%
- [ ] [test] Draw a venue (walkable area, source, gate group with 4 lanes, destination), save, reload: unchanged (Playwright)
- [ ] [test] Undo/redo returns the document to exactly the previous state
- [ ] [test] Validation flags an unreachable source and a self-intersecting polygon
- [ ] [test] A read-only link shows the venue but rejects edits

### Phase 6: Showcase
- [ ] [human] A first-time visitor loads an example, runs it and compares two scenarios without instructions
- [ ] [test] Every invariant in 7.1 has a passing test, listed in the README

### Phase 7 (optional): Parking layout generator
- [ ] [test] A 50 × 100 m rectangle at 90° gives the stall count of a hand calculation from the default dimensions
- [ ] [test] Three variants can each be simulated and compared

### Phase 8 (optional, paid): AI auto-draft
- [ ] [test] With the flag off, no AI endpoint is reachable
- [ ] [test] Rejecting every draft element leaves the venue unchanged; an AI timeout shows a clear message

---

## 5. Fixed rules (consolidated)

All Fixed rules from spec sections 4.1, 4.5, 5, 7, 8 and 11 in one place (review A1). "Check" says how each is enforced: [test], [lint], [CI] or [human].

| # | Rule | Source | Check | Status |
|---|---|---|---|---|
| F1 | Engine is pure TypeScript, no DOM; runs in a Web Worker and in Node | 4.1, 7.1-6, 8 | [lint] + tsconfig without DOM | ✅ from Phase 0 |
| F2 | Fixed 0.25 s movement step; playback speed only changes steps per real second | 4.1 | [test] `simulation.test.ts` | ✅ |
| F3 | Exact (unrounded) service times as scheduled events; events drained in (time, kind, id) order within a tick (D-004) | 4.1 | [test] | ✅ core and lanes (Phase 1) |
| F4 | Counter-based seeded randomness (D-003); only exact arithmetic plus in-repo `ln`/`exp` (D-005); iteration ordered by id, never by Map/Set insertion | 4.1 | [lint] + [test] | ✅; ordering rule reviewed in code review |
| F5 | Snapshots ~20/s as structure-of-arrays Float32Array, Transferable, double-buffered, no SharedArrayBuffer, dropped if the renderer lags | 4.1 | [test] | ✅ Phase 1 (D-029) |
| F6 | Metrics per lane and venue-wide as listed in 4.5 | 4.5 | [test] | ✅ pedestrian metrics (Phase 1, D-025); vehicles in Phase 3 |
| F7 | Every default parameter editable, stored with every run, labelled "assumed" in the UI | 5, 7.1-7 | [test] + [human] | ✅ parameters stored with every run and shown as assumed (Phase 1); [human] part with the owner |
| F8 | Determinism: bit-identical metrics in Node (CI) and Chrome's Web Worker | 7.1-1 | [test] Playwright | ✅ self-check (Phase 0) and Playwright Node-vs-Chrome in CI (Phase 1, D-031) |
| F9 | Geometry in metres; translation identical; small rescale < 2% | 7.1-2 | [test] | ✅ Phase 1 (D-016) |
| F10 | Conservation of agents across states | 7.1-3 | [test] | ✅ Phase 1 (fixture and example runs) |
| F11 | Physical rules: walkable areas only; one agent per lane; failed lane serves none | 7.1-4 | [test] | ✅ Phase 1 (`run.test.ts`) |
| F12 | Little's law within 3% on every lane | 7.1-5 | [test] | ✅ Phase 1 (lane core, fixture run, examples) |
| F13 | No paid API required; AI draft off by default | 7.1-8 | [test] | Phase 8 |
| F14 | No secrets in the client or the repository | 7.1-9 | [CI] secret scan + review | Phase 4 adds a scanner |
| F15 | UI never freezes; engine off the main thread | 7.2 | [human] + [test] | ✅ engine in a Web Worker (Phase 1); [human] performance check open |
| F16 | Validation tests (queueing family) and Little's law on every CI run | 7.2 | [CI] | ✅ queueing family and Little's law run in CI (Phase 1) |
| F17 | Security rules for keys, uploads, rate limits, headers; threat model | 7.2, 8 | [test] | CSP ✅; rest in Phase 4 |
| F18 | ASP.NET Core on .NET 10; PostgreSQL via EF Core with jsonb documents | 8 | — | Phase 4 |
| F19 | Sharing without logins: public id, readToken, editKeyHash, 256-bit key, constant-time compare, `X-Edit-Key` header, fragment link | 8 | [test] | Phase 4 |
| F20 | Uploads: PNG/JPEG by magic bytes, ≤ 5 MB, ≤ 4096 px, re-encoded, stored outside the web root | 8 | [test] | Phase 4 |
| F21 | Shared JSON Schema in `/schema`, generated types checked in CI, backend validates writes, `schemaVersion` with migrations | 8 | [CI] `schema:check` + [test] | TS ✅; C# in Phase 4 |
| F22 | Learning notes every phase (now in section 7 of this document, D-001) | 11 | [human] | ✅ Phase 0 |

---

## 6. Phases

### Phase 0: Foundation

**Plan** (2026-11-11)
- Monorepo with npm workspaces: `packages/engine`, `packages/schema`, `apps/web`. The API is added in Phase 4.
- Engine core: counter-based randomness, deterministic `ln`/`exp`, distributions, an event queue with a total order, the tick loop, the playback pacer, the Float64 metrics hash, and an engine self-check.
- JSON Schema for venue, scenario and run, with TypeScript generation and a CI freshness check.
- Vitest, ESLint (with engine purity rules), GitHub Actions CI, Vercel deployment with a strict CSP.
- A minimal live page that runs the engine self-check in a Web Worker.
- *Risks:* deterministic `ln`/`exp` accuracy (mitigated by tests against `Math.log`/`Math.exp`); generator quirks with cross-file `$ref`s (they appeared and were fixed by file-qualified refs).

**Summary**
- **Built:** everything in the plan. 56 tests: 43 engine, 13 schema. Lint, typecheck and build are clean. The production build was checked locally under the production CSP: Chrome's Web Worker computes the same self-check hash as Node (`65c22d4016e96961`, 48,959 numbers in about 12 ms).
- **Deferred:**
  - The Playwright Node-vs-Chrome test moves to Phase 1, where it checks a real scenario instead of the self-check.
  - C# generation from the schema moves to Phase 4.
- **Section 10 defaults used:** product name "Bottleneck"; English UI; free static hosting (Vercel) until Phase 4; units in metres and seconds, with times relative to event start.
- **Known limitations:**
  - The schema covers only the pedestrian elements so far (vehicles come in Phase 3).
  - `run.metrics` is an open object until Phase 1.
  - The page is a placeholder: no simulation view yet.
- **Owner checks ([human]):** see [section 1](#what-the-owner-needs-to-do-now). Open the Vercel URL, confirm the green "Match" line.

### Phase 1: Pedestrian simulation

**Plan** (2026-11-11), split into milestones so each one ends with passing tests and a merge.
- **1a. Lane queueing core + validation tests (done, 2026-11-11).** `LaneBank` in `packages/engine/src/lanes.ts`: logical FIFO per lane, exact service events, scan retry, lane failure, per-lane metrics. Validated against queueing theory in `packages/engine/test/queueing.test.ts` (decisions D-011 to D-013).
- **1b. Pedestrian world (done, 2026-11-11).** Walkable grid, flow fields (shortest-path distance maps towards each destination), density and the Weidmann speed-density relation (with the floor from B4), movement in 0.25 s steps, lane choice, spillback when the queue area is full, the run API, and the metrics from spec 4.5.
- **1c. Example venues (done, 2026-11-11; retuned 2026-11-12, D-028).** Belgrade Fair on a fair day and a concert, in `packages/examples`, as schema-valid venue and scenario JSON.
- **1d. Worker protocol, renderer and simulation view (done, 2026-11-11).** Messages between the page and the engine Web Worker, snapshots as Transferable Float32Arrays, a PixiJS renderer, and the simulation view with play, pause and speed.
- **1e. Replay, heatmap, performance overlay and the browser hash test (done, 2026-11-12).** Replay with a scrubber, a density heatmap, the `?perf=1` overlay, and the Playwright test that compares the metrics hash in Node and in Chrome's Web Worker.
- *Risks:*
  - **Performance at 10,000 agents:** frame p95 under 33 ms and worker tick p95 under 12 ms is a target, not a gate (review A8). Mitigation: structure-of-arrays data, no allocation in the tick, measure early in 1b.
  - **PixiJS under the strict CSP (D-009):** PixiJS v8 should work without `unsafe-eval`, but this is only known once it runs under the production headers. Check in 1d with `npm run build` and `npm run preview`.
  - **Replay memory:** storing every snapshot would pass 200 MB, so replay uses adaptive keyframes plus engine checkpoints (review C1). Check memory early in 1e.

**Summary** (Phase 1 so far; the two [human] checks and the merge are still to do)
- **Built:** milestones 1a to 1e.
  - **Engine** (`packages/engine`): walkable grid, flow fields, density and Weidmann speed, logit lane choice, spillback, jockeying, scan failures with a manual lane, timed lane failures, groups, bag policy, mixture distributions, checkpoints, deadlock watchdog, the run API and the full set of metrics with a hash (decisions D-014 to D-027).
  - **Examples** (`packages/examples`): Belgrade Fair concert (3 lanes, 5 lanes, 5 lanes with a failure) and fair day (baseline, bus burst, gate A reduced), each simulated headless in `exampleRuns.test.ts` (D-028).
  - **Web** (`apps/web`): worker protocol, PixiJS renderer, simulation view with play, pause, speed, seek, "Jump to peak", heatmap and `?perf=1` overlay (D-029, D-030).
  - **Playwright** (`apps/web/e2e`): the Node-versus-Chrome hash test and a smoke test under the production CSP, in their own CI job (D-031).
- **Measured** (on the development machine; real numbers, not targets):
  - **10,000 pedestrians in Node:** engine tick p95 about **2.7 ms** (target 12 ms).
  - **Browser Web Worker at 4,500 pedestrians (concert example):** tick p95 **0.7 to 1.6 ms**.
  - **Frame time (renderer)** on the reference machine is the [human] check still open.
  - **Example results** (seed 1; "outside at start" = people not yet through the gate when the event starts; "peak p95" = 95th-percentile wait in the busiest hour):

    | Scenario | People | Outside at start | Peak p95 wait | Mean wait | Max queue, gate A |
    |---|---|---|---|---|---|
    | Concert, 3 lanes | 4,500 | 1,312 | 1,630 s | 905 s | not applicable |
    | Concert, 5 lanes | 4,500 | 177 | 121 s | 79 s | not applicable |
    | Concert, 5 lanes, one fails | 4,500 | 330 | 337 s | 188 s | not applicable |
    | Fair day, baseline | 4,000 | not applicable | 85 s | 53 s | 22 |
    | Fair day, bus burst | 7,000 | not applicable | 144 s | 72 s | 52 |
    | Fair day, gate A reduced | 4,000 | not applicable | 135 s | 70 s | 40 |

    Every example drains with nobody unreachable and no deadlock. Before the 2026-11-12 retune (D-028) the concert showed 1,330, 252 and 389 people outside at the start (3 lanes, 5 lanes, with a failure), which made "more than 5 times as many with 3 lanes" tight (5.3 times); now it is 7.4 times.
- **Deferred:**
  - Frame-time measurement on the reference machine and the "jam within 2 minutes" look (owner checks).
  - Table alternatives for charts and the mobile canvas rule (review C6) move to the UI polish in Phase 2.
  - `carShare`, vehicles and `TurnedAway` for cars: Phase 3 (D-022).
- **Known limitations:**
  - All defaults are assumptions (walking speed, scan times, group sizes, lane-choice parameters), not measurements.
  - Pedestrians do not avoid each other except through the speed-density relation.
  - Lanes are evenly spaced along one line per gate group; the manual lane is a modelling choice (D-015).
  - Headless Chrome renders in software and plays slowly, so the smoke test seeks to the peak instead of waiting; the engine itself is not the limit.

### Phase 2: Scenarios and comparison

**Plan** (2026-11-12), client-side (spec 6.3):
- Scenario library per venue: built-ins read-only, user scenarios created from a built-in or from defaults, duplicated, renamed, deleted and edited; localStorage with a versioned key and JSON export/import (D-032).
- Editor for every scenario field the spec lists, validated against the JSON Schema before saving, under the strict CSP (D-033).
- Interactive "fail lane now" / "reopen" during playback, recorded in a working copy (D-035).
- Comparison of up to 4 scenarios and batches of up to 5 seeds in background workers, with differences in words, overlaid queue charts, capacity against demand and the outside-at-start split (D-034); "+1 lane" opens it.
- Scan logs: export a finished run's log as CSV, import a log, fit, apply to a new scenario (with `@bottleneck/analysis`, built in parallel).
- *Risks:* Ajv under the CSP (solved by build-time code generation); run time of several concert runs in the browser (solved by a worker pool).

**Summary**
- **Built:** everything in the plan. The web app now has four sections: Simulate, Scenarios, Compare, Scan logs (D-036). The package `packages/analysis` holds `summarise` (mean and 95% CI, exact t table), paired differences, and the scan-log generator, importer and fitter (D-037 to D-039); the engine got `run.serviceLog()`.
- **Tests:** Vitest for all new logic (`apps/web/src/library/library.test.ts`, `compare/compare.test.ts`, `scanlog/scanlog.test.ts`: storage, form round trip, schema validity of editor output, the build-time validator against Ajv, import/export, seeds, differences in words, paired CIs, chart alignment, applying a fit). Playwright: `compare.spec.ts` (the Phase 2 acceptance check), `library.spec.ts` (create, save, reload, JSON export and import, scan-log export, import, fit and apply), and the updated `replay.spec.ts` ("+1 lane" opens the comparison).
- **Measured** (development machine, production build in Chrome): 2 concert runs compared in about 2.3 s (2 workers); a 5-seed batch of the 3-lane concert in about 6.3 s (4 workers). In headless Chromium with the map visible the 2-run comparison took about 10 s.
- **Example:** 3 vs 5 lanes, seed 1: still outside at the start 1,312 → 177 people; p95 wait in the peak arrival hour 27 min 10 s → 2 min 1 s. Over 5 seeds the 3-lane concert gives 1,295 ± 39 people outside at the start (mean ± 95% CI).
- **README:** a GIF (15 s, 960 px wide, about 4 MB) and a screenshot in `docs/media/`, recorded against the production build by `apps/web/e2e/record-demo.spec.ts` (skipped unless `RECORD_DEMO=1`). The live link is added after the deployment check (owner).
- **Deferred:** the live link in the README (the [human] check, after the merge). Undo in the editor (Phase 5, review C4). Editing custom arrival points by hand (only via the JSON box or a fitted scan log).
- **Known limitations:** scenarios live in one browser until Phase 4; a lane event recorded late in a run costs a re-run up to that moment; the fitted service time includes scan retries, so it slightly overstates the pure scan time when scan failures are on.

### Phase 3: Vehicles, parking and departures

**Plan** (2026-11-13)
- **3a. Schema:** roads, vehicle sources, barriers, lots and crossings; scenario car parameters, departures and `lotClose` (D-040).
- **3b. Engine:** road graph and routing, car-following, barriers on the shared lane core, parking with reservations, overflow, counting of people and cars, departures (D-041 to D-048); metrics (D-051).
- **3c. Examples:** a stand-alone car park (three scenarios) and the Belgrade Fair car parks (four scenarios) (D-052).
- **3d. Web:** cars on the map, parking panels, departure and car fields in the editor, parking rows in the comparison (D-053).
- *Risks:* gridlock of cars (mitigated by reservations, D-043); a plate system that is not faster than tickets (it turned out to be a finding, D-049); run time with 2,000 cars (measured below); example outcomes of Phase 1 changing when the venues grew (checked: identical, D-052).

**Summary** (2026-11-13; merged into `main` **locally**, not pushed: the owner pushes together with Claude)
- **Built:** 3a to 3d. Local checks: `npm run check` (263 tests) and `npm run test:e2e` (6 passed, 1 skipped: the demo recorder) pass. The web view was looked at in the browser on the car park example: entry queue backing up onto the main road before the start, cars parking, the exit rush with queues at the pay machines and the exit barrier, and the comparison pay machines → pay at the barrier (49 min 21 s → 1 h 05 min until empty; exit queue 12 m → 192 m). Not looked at: the Belgrade Fair car scenarios in the browser, dark mode, phone width.
- **Measured** (Node, development machine):
  - **10,515 pedestrians and 2,000 cars:** tick mean **2.07 ms**, p95 **5.52 ms**; the vehicle step on its own has a p95 of about **0.4 ms**. The target is 12 ms.
  - The four Belgrade Fair car scenarios take about 3 s each headless; the whole example suite (all 13 scenarios and the car-park tests) about 26 s.
- **Example results, stand-alone car park** (seed 1, 320 stalls, about 650 people in 329 cars, departures by the concert preset):

  | Scenario | Lot empty after the end | Pay-machine wait | Exit queue |
  |---|---|---|---|
  | Pay at the machines (4 machines, 2 exit lanes) | 49 min | about 293 s | at most 12 m |
  | Pay at the barrier (2 exit lanes) | 66 min | none (no machines) | up to 192 m |
  | Pay at the barrier, 3 exit lanes | 49 min | none | shorter |

  The entry queues reach the main road during the arrival peak (recorded with their time). Paying at the barrier costs 17 minutes; a third exit lane wins them back.
- **Example results, Belgrade Fair car parks** (seed 1):

  | Scenario | Cars | Parked / turned away | Time to empty after the end | Exit queue (max, mean) |
  |---|---|---|---|---|
  | Fair day with cars (55%), 4,000 people | 1,056 | 554 north + 502 south / 0 | north 37 min, south 29 min | north (pay at the barrier) 210 m, 68 m mean; south (machines) 19 m, 2.4 m mean |
  | Fair day, north car park closes after 30 min | 1,056 | 803 / 253 | north 27 min, south 45 min | north 12 m; south 19 m; south full at 480 |
  | Concert with cars and departures (35%), 4,500 people | 763 | 640 / 123 (lot full) | 65 min (pay at the machines) | 256 m, 73 m mean (3 exit lanes) |
  | Concert car park, pay at the exit barrier | 763 | 640 / 123 | 104 min | 256 m, 133 m mean |

  What they show: on the fair day, **both car parks cope** and the pedestrians' waits stay normal (peak p95 86 s against 85 s without cars); the long exit queue is only at the north car park, where drivers pay at the barrier. Closing the north car park makes its cars **divert** to the south one (381 cars), the south fills up (480 of 480), and 253 cars are turned away; the south pay machines then have a mean wait of about 588 s. At the **concert**, the lot fills up and 123 cars are turned away; the exit rush builds a queue of up to **256 m (139 cars)** at the exit barrier even with 3 lanes and machines, and **paying at the barrier empties the lot 39 minutes later and almost doubles the mean queue** (133 m against 73 m). Everyone departs or is turned away, nobody is unreachable, no deadlock, Little's law below 1e-9 on every barrier and machine lane.
  The concert's pedestrians still cope with 5 gate lanes (360 people outside at the start, up from 177 without cars, because the car park's walk-ins arrive together in the peak).
- **Existing examples unchanged:** the six Phase 1 scenarios give the same numbers to the last bit (D-052).
- **Deferred:** the [human] performance check in the browser; the web-view gaps listed in D-053; scenarios with plate recognition at the Belgrade Fair car parks (the stand-alone example and the tests cover plate against ticket).
- **Known limitations:** all vehicle defaults are assumptions (D-040, D-044); cars have no acceleration and no overtaking (D-042); the car parks and roads of the Fair are hand-drawn, not surveyed; occupants walk in a straight line inside a lot (off the walking grid); a lot has no one-way aisle rules beyond the drawn direction of roads.

---

## 7. How it works (learning notes)

### Phase 0: the foundation, in plain language

**The big picture.** Bottleneck is three packages in one repository (a *monorepo*):

```
schema/                  JSON Schema files: the shape of a venue, a scenario and a run
packages/schema          TypeScript types generated from those files
packages/engine          the simulation: pure TypeScript, no browser, no network
apps/web                 the website (React); runs the engine inside a Web Worker
```

The engine is kept pure so the *same code* can run in three places: in the browser for the live animation, in Node for tests, and (from Phase 4) on the server for batch jobs. If all three give bit-identical results, a result computed on the server can be trusted to match what the user saw.

**Why determinism is harder than it sounds.** A simulation is "deterministic" if the same inputs always give the same outputs. Two things usually break that:

1. *Randomness.* `Math.random()` gives different numbers every time. Instead we use a **seed**: a number that fully decides every "random" value. Same seed, same run.
2. *Floating-point functions.* JavaScript guarantees that `+ − × ÷` and `Math.sqrt` give exactly the same result everywhere (IEEE-754 rules). It does **not** guarantee that for `Math.exp`, `Math.log` or `Math.sin`: each engine may round the last bit differently. One different bit early in a run can grow into a different queue later. So `detmath.ts` builds `ln` and `exp` from the guaranteed operations only:
   - `ln(x)`: split x into mantissa × 2^k by reading its bits, then use a fast-converging series for the mantissa.
   - `exp(x)`: write x = k·ln2 + r with a small r, compute e^r with a Taylor series, then multiply by 2^k by writing the exponent bits.

**Counter-based randomness (the key idea of this phase).** A normal random generator is like a tape you read in order: number 1, 2, 3… If one extra lane makes the simulation read one extra number early on, *everyone after that gets a different number*. Then you can't tell whether "5 lanes is better than 3" is due to the lanes or to luck.

So instead of a tape, Bottleneck uses a *hash function* as a lookup: `uniform(seed, stream, entity, index)`. "What is agent 42's first scan time in run 7?" always gives the same answer, no matter what else happened. This is called **common random numbers**, a standard variance-reduction technique in simulation. The hash mixes the four inputs through a 32-bit mixer that is a *bijection* (it never maps two inputs to the same output) with strong *avalanche* (flipping one input bit flips about half the output bits). Tests check this, plus a chi-square test for uniformity and correlation tests between neighbours.

**Turning uniform numbers into useful ones.** `distributions.ts` converts a uniform u in (0, 1) into a specific distribution:
- *Exponential* (time between random arrivals): −mean · ln(u).
- *Normal*: the inverse CDF, i.e. "which z has probability u of being below it?", using Acklam's formula.
- *Truncated normal* (walking speed between 0.5 and 2.2 m/s): draw, and redraw if outside the bounds.
- *Shifted lognormal* (service times): never below a minimum, occasionally slow, like a real turnstile scan.

**The event queue and the tick loop.** The simulation has two kinds of time:
- **Ticks**: every 0.25 simulated seconds, people take a small step. This makes movement smooth and simple.
- **Events**: things that happen at an exact moment, such as "person 17 finishes scanning at t = 3.1 s". These live in a *priority queue* (a binary min-heap) sorted by (time, kind, id, insertion number). The sort key is total (no two events tie), so the processing order is identical on every machine.

In every tick the loop (1) processes all events due up to the end of the tick, in order, including events that other events create along the way, and then (2) runs the per-tick systems (movement and so on, added in Phase 1). Because of step 1, a lane can start serving the next person the instant the previous one finishes, instead of waiting for the next tick. Without this, queueing maths would be off by up to 0.25 s per person.

**Playback speed** never changes the tick length. At 1× the worker runs 4 ticks per real second; at 60× it runs 240. `PlaybackPacer` turns elapsed real time into a whole number of ticks and carries the fraction to the next frame.

**Proving it works in a browser: the self-check.** `runSelfCheck()` runs a fixed workload (random numbers, `ln`/`exp`, and a tiny one-lane queue on the event loop) and hashes every number it produced. The hasher feeds the *exact 8 bytes* of each double into the hash, because JSON text could hide or invent last-bit differences. A unit test pins the hash in Node. The live page runs the same function in a Web Worker and shows whether Chrome got the same hash.

**One schema, many languages.** The formats for venues, scenarios and runs are written once as JSON Schema. A script generates TypeScript types from them, and CI fails if someone edits the schema without regenerating. In Phase 4 the same files generate C# classes, and the .NET API validates every write against the same schema. Shared example files (`schema/fixtures/`) are tested by both sides, so the frontend and backend can never silently disagree about the data.

**Guard rails.** The engine's tsconfig has no DOM library, so writing `document` in the engine doesn't compile. ESLint bans `Math.random`, `Math.exp`, `Date.now`, `window`, `fetch` and similar in the engine, with a message saying what to use instead. The web app's Content-Security-Policy allows only scripts from its own origin, so even if an attacker injected HTML, no script would run.

**Data flow in Phase 0:** browser loads page → React starts a Web Worker → worker imports the engine and runs `runSelfCheck()` → posts `{hash, expected, matches}` back → React shows ✓ or ✕.

#### Interview questions (Phase 0)

1. **Why not use `Math.random()` with a seed library and call it a day?**
   A seeded sequential generator is deterministic, but changing the scenario (one more lane) changes how many numbers are consumed, so every later agent gets different numbers. Counter-based randomness ties each number to *who* and *what for*, giving common random numbers across scenario variants and much less noise in comparisons.

2. **Why can't the engine use `Math.exp`?**
   ECMAScript only requires `Math.exp` to be an "implementation-approximated" value, so engines may differ in the last bit. Only the basic arithmetic operations and `sqrt` are required to be correctly rounded. Bit-identical results across browser and server need those alone, so `exp` and `ln` are implemented from them.

3. **What is a binary heap and why use it for events?**
   It is an array-based tree where each parent is smaller than its children, giving O(log n) insert and remove-min. Simulations constantly need "the next event in time", and a heap does that efficiently. A total sort key (time, kind, id, sequence) makes the order deterministic even when events have equal times.

4. **Why hash raw Float64 bytes instead of `JSON.stringify` results?**
   JSON number formatting is lossy in edge cases (−0 becomes "0") and makes the comparison depend on formatting rules. Hashing the 8 IEEE-754 bytes compares exactly the bits the computation produced. Normalising −0 and NaN first removes the two harmless differences.

5. **What does "generate types from JSON Schema, and fail CI if they're stale" protect against?**
   Drift between the frontend, the backend and the stored data. The schema is the single source of truth. The TypeScript (and later C#) types are derived from it, and the stale check guarantees that nobody edits one side without the other.

### Phase 1: the pedestrian simulation, in plain language

Phase 1 has two layers: a *lane queueing core* (how a queue behaves) and a *pedestrian world* around it (where people walk, which lane they pick, what the browser shows). We start with the core, then go outwards.

#### The lane queueing core

**What a lane is.** A lane (a turnstile, a scanner, a gate) serves one person at a time. Everyone else waits in a line. `lanes.ts` holds that logic: who is in line, who is being served, how long each person waited. It uses exact event times, so a 3.1 s service takes exactly 3.1 s, not "3.25 s because of the tick".

**The names D/D/1, M/D/1, M/G/1** (Kendall notation: arrivals / service / number of servers):
- **D/D/1:** *D*eterministic arrivals, *D*eterministic service, 1 lane. Example: one person every 1.0 s, each takes 0.8 s. The queue is always empty. If a person arrives every 0.8 s and takes 1.0 s, the queue grows by exactly (λ − μ)·t people, where λ is the arrival rate and μ the service rate. We test both cases.
- **M/D/1:** *M*arkovian (random, Poisson) arrivals, *D*eterministic service. People arrive at random moments, but every scan takes the same time.
- **M/G/1:** random arrivals, *G*eneral service times (any distribution). Here the scan time is our default shifted lognormal: never below 2.5 s, 4 s on average, sometimes slow.

**The formulas we test against.** ρ ("rho") is utilisation: arrival rate × average service time. Below 1 the queue is stable.
- M/D/1: average queue length **Lq = ρ² / (2(1 − ρ))**. At ρ = 0.7 that is 0.49 / 0.6 = 0.817 people waiting (the person being served is not counted).
- M/G/1, the Pollaczek–Khinchine formula: average wait **Wq = λ·E[S²] / (2(1 − ρ))**, where E[S²] is the average of the *squared* service time. It depends on the spread of service times, not only the average: a lane with the same average but more variation has longer queues. That is why the test uses the exact E[S] and E[S²] of our distribution (D-005, D-007).

**Why the confidence-interval rule has two parts.** We run 20 seeds and compute the mean and a 95% confidence interval (CI): a range that should contain the true value 95% of the time. Rule (review B6):
1. The CI must **contain** the theoretical value. This catches a *biased* simulation (a systematic error).
2. The CI half-width must be **under 3%** of the theoretical value. Without this, a very noisy test would have a huge CI that contains anything and would pass by accident.

Both together mean "right on average, and measured precisely enough to notice a small error". The M/G/1 test needs 40 simulated hours per seed to be precise enough (D-012). Each run also skips the first hour (*warm-up*), because the queue starts empty, which is not typical.

**Little's law.** **L = λ·W**: the average number of people in a system equals the arrival rate times the average time each spends in it. It holds for almost any queue, whatever the distributions. Example: 2 people arrive per second and each waits 30 s on average, so about 60 people are in the queue. We use it as a bookkeeping check: the queue length (counted by integrating over time) and the waits (summed per person) are two independent ways of counting the same person-seconds, so they must agree. For people still queuing when the window ends we include their wait so far (D-011).

**Other behaviours** (D-013): the wait starts when a person commits to a lane, even if still walking towards it; a failed lane finishes the person in service and hands the rest back in arrival order; a failed scan keeps the lane busy and retries; a second failure sends the person to the manual lane.

#### The pedestrian world: grid and flow fields

The venue is drawn as polygons (walkable areas, obstacles) in metres. The engine turns them into a **grid of 0.5 m cells** (`geometry.ts`) with a *scanline fill*: for each row of cell centres, find where the row crosses the polygon edges, sort the crossings and fill between pairs. A cell is walkable if its centre is inside a walkable area and not inside an obstacle. The grid is anchored to the bounding box of the walkable areas (coordinates rounded to 1/1024 m, D-016), so moving the whole venue moves the grid with it and the numbers stay identical.

Nobody does path-finding while walking. Instead, for each target (a lane's queue tail, a destination) the engine builds one **flow field** in advance (`flowField.ts`): the walking distance from every cell to the target, and for every cell the neighbour to step to next. A person just looks up their cell and walks towards the next cell's centre. Thousands of people share the same few fields, so the cost is paid once.

The distances come from **Dijkstra's algorithm**: start at the target with distance 0, and repeatedly settle the unsettled cell with the smallest distance, updating its 8 neighbours (a straight step costs 0.5 m, a diagonal 0.5·√2 m; a diagonal step is not allowed if it would cut a wall's corner). The textbook version keeps the frontier in a binary heap, which costs O(log n) per cell. Our steps are never cheaper than 0.5 m, so we use a **bucket queue** (Dial's algorithm): bucket k holds cells whose tentative distance lies in [0.5·k, 0.5·(k+1)). No cell in a bucket can improve another cell in the same bucket, so a bucket can be processed in any order. That is O(1) per cell and gives exactly the same distances as the heap. We know it is the same because the metrics hash did not change (D-027).

#### Density and the Weidmann curve

People slow down in crowds. Every tick the engine counts people per 2 m cell, smooths the counts a little with a Gaussian kernel, and divides by the walkable area in the neighbourhood (a cell that is half wall is not "half as crowded"). The speed follows the **Weidmann relation**: v = v₀ · (1 − exp(−γ · (1/ρ − 1/ρmax))), with ρ in people per m², γ = 1.913 and ρmax = 5.4. In words: at low density you walk at your free speed v₀; as density approaches 5.4 people/m² you almost stop. Two guards from review B4 stop the formula from misbehaving: below ρ = 0.1 the person walks at v₀ (1/ρ would blow up), and the speed never goes below 0.1·v₀ (so a crush creeps instead of freezing forever). Because a jam raises the density near the gate, and that lowers the speed, queues behave like real ones: they feed themselves.

Most cells are empty, so the engine only recomputes the neighbourhoods of occupied cells ("sparse density"). A cell far from anyone has an exact 0 in every term of the smoothing, so skipping it gives the same result.

#### Choosing a lane: the logit model

Within 20 m of a stage, a person chooses a lane. With probability 0.3 they just take the nearest one. Otherwise they use a **logit** (also called softmax) choice. Each lane gets a cost in seconds: the walk to it, plus the people already committed to it times the mean service time. The probability of a lane is proportional to exp(−cost/τ), with τ = 15 s. Two lanes with equal cost are equally likely; a lane that costs 15 s more is e (about 2.7) times less likely; a lane that costs 60 s more is rarely chosen, but not never, which is how real people behave (they do not know the queues exactly). `exp` here is our own deterministic `exp` (D-005), not `Math.exp`. A person may also *jockey* once to a lane with at least 3 fewer people ahead (D-021), and when a lane fails its queue is redistributed in arrival order (D-020).

#### Spillback

A lane's queue area has a fixed length (say 10 m, 0.6 m per person). If more people commit to the lane than fit, the rest stand behind the queue area in rows (D-019). They have already committed, so their waiting time already runs (D-014). This is why the wait starts at commit: if it started only when a person reached the queue area, a jam spilling out into the street would look harmless in the numbers. The density near the gate then rises, which slows everybody behind it.

#### From engine to screen: the data path

```
engine.worker.ts  (Web Worker)            main thread
 +---------------------------+          +---------------------------+
 | run.step() x N ticks      |          | SimController             |
 | writeSnapshot(buffer)     | -------> | VenueRenderer (PixiJS)    |
 | stats / metrics messages  | <------- | React panels and charts   |
 +---------------------------+          +---------------------------+
                      returnBuffer, play, seek ...
```

The engine runs in a Web Worker so the page never freezes (F15). About 20 times per second the worker fills a `Float32Array` with x, y, vx, vy and state for every person (a *structure of arrays*: all x values, then all y values, and so on) and sends it to the page as a *Transferable*: ownership of the memory moves to the page without copying. The worker owns two buffers (*double buffering*). The page sends a buffer back when it has a newer one. If the worker wants to send a snapshot but both buffers are away (the renderer is slow), it **drops** the snapshot instead of queuing it, so latency never grows (D-029). Between snapshots the renderer extrapolates positions from the velocities, so 20 snapshots per second look smooth. PixiJS draws all people as one particle container from a small texture atlas, and a special add-on lets it run without `unsafe-eval`, so the strict CSP stays (D-030).

#### Determinism across Node and Chrome, and how Playwright proves it

Invariant 1 says the same scenario gives bit-identical metrics in Node and in a browser. It holds because the engine uses only operations that every JavaScript engine must compute identically (D-005), iterates in id order, takes its randomness from counter-based hashing (D-003), and never reads the clock. The proof is the Playwright test `determinism.spec.ts`: Playwright starts the production build (`vite preview`, with the production CSP), and the test runs a tiny pinned scenario in Node and compares the metrics hash with the one the page's Web Worker computes for the same scenario. The hash covers the exact bytes of every metric (D-006), so a one-bit difference anywhere fails the test. CI runs it on Linux with Node 24 and Chromium. A second test (`smoke.spec.ts`) loads the real page and fails on any console error or CSP violation (D-031).

#### Checkpoints

A seek to "30 minutes before the start" would take a long time if the engine had to simulate from the beginning every time, and storing every snapshot would use too much memory. A **checkpoint** is a copy of all the dynamic state of a run (positions, states, lane queues, histories, counters, the next-arrival pointer) in typed arrays. `restoreRun()` rebuilds the static parts (grid, flow fields) from the venue and scenario, loads the checkpoint, and carries on. Because the run is deterministic, the restored run is *bit-identical* to the original from that moment on; a test proves it by comparing metrics hashes. The worker takes one every few simulated minutes within a 64 MB budget; a seek restores the nearest earlier checkpoint and steps forward (D-026).

#### Interview questions (Phase 1)

1. **Why test a simulator against M/M/1-style formulas instead of just checking that it "looks right"?**
   Queueing theory gives exact answers for simple cases (for example Lq = ρ²/(2(1−ρ)) for M/D/1). If the simulator matches them within a stated statistical tolerance, the core logic (event order, service start, waiting time) is right, and later complexity (walking, lane choice) is built on something verified.

2. **What does the Pollaczek–Khinchine formula tell you that "average service time" does not?**
   The average wait depends on E[S²], so on variability, not just the mean. Two lanes with the same average scan time and the same arrival rate have different queues if one has more spread. Reducing variation (consistent scan times) shortens queues without making anyone faster on average.

3. **Why does the test check that the confidence interval is narrow, not only that it contains the theoretical value?**
   An interval can contain the true value by being very wide. Requiring the half-width to be under 3% means a bias larger than about 3% would be detected, so "passes" means "measured accurately and correct", not "too noisy to disagree".

4. **Why do 10,000 people not need 10,000 path searches?**
   People walk by looking up their cell in a *flow field*: one precomputed shortest-path table per destination (Dijkstra, with a bucket queue for speed). The cost depends on the number of targets and the size of the grid, not on the number of people, and each person's move is a table lookup.

5. **Why does the wait start when a person commits to a lane, not when they reach the queue area?**
   With a long queue the end of the line is outside the queue area, in the street. If the clock started only at the queue area, the people in the spillback would not count, and the worst jams would look mild in the numbers. Starting at commit measures what the visitor experiences; `queueWait` additionally reports the part spent standing in the line.

6. **How can a snapshot stream to the renderer never make the engine slower?**
   The worker owns two buffers and sends them as Transferables. If the page has not handed one back, the worker drops that snapshot and carries on, so a slow renderer costs frames, never engine time or memory. The renderer smooths the gaps by extrapolating from the velocities in the snapshot.

7. **How do you know the browser result equals the Node result, and what would break it?**
   A Playwright test runs the same tiny scenario in Node and in the built app's Web Worker and compares a hash of the exact bytes of the metrics. It would break if the engine used a function that engines compute differently (`Math.exp`), depended on iteration order, or read the clock; lint rules forbid these in `packages/engine/src`.

8. **What is a checkpoint, and why can a replay jump backwards quickly?**
   A checkpoint is a copy of everything that changes during a run. Because the engine is deterministic, restoring a checkpoint and stepping forward gives exactly the state that playing from the start would give. A backward seek restores the nearest earlier checkpoint and steps at most one interval forward, instead of re-running the whole event.

### Phase 2: scenarios and comparison, in plain language

#### Saving in the browser, with versions
There is no server yet, so scenarios are saved in the browser's **localStorage**: a small key-value store per website that survives a reload. Three things can go wrong, and each is handled:
1. **Storage is not there or says no** (private mode, a full quota). Every access is wrapped in try/catch; the page then says that saving is off instead of breaking.
2. **Old data.** Everything sits under one key with a version in its name and inside it (`bottleneck.scenarios.v1`, `version: 1`), and every scenario carries its own `schemaVersion`. A future build that reads version 2 recognises version-1 data instead of misreading it.
3. **Data that no longer fits.** An entry that is broken or from another schema version is dropped with a visible notice, and a raw copy is kept under a second key, so nothing vanishes silently. Real migrations come with the database in Phase 4.

#### Validating against the schema when `eval` is forbidden
The JSON Schema in `/schema` is the single definition of a scenario. Ajv, the usual validator, turns a schema into fast JavaScript at run time with `new Function(...)`, which is a form of `eval`. The page's Content-Security-Policy forbids `eval`, because injected text must never become running code. The way out is to do that compilation **at build time**: Ajv's "standalone" mode writes the validator as an ordinary JavaScript file, which the build bundles like any other code. A test checks that this generated code gives the same answers as Ajv itself, and the build fails if the code would still need `eval`. The schema check is followed by checks the schema cannot express (does lane 7 exist in this scenario?), and every error is turned into a sentence a person can act on.

#### Common random numbers: comparing like with like
A run is random: arrival times, walking speeds, scan times all come from the seed. If "3 lanes" and "5 lanes" ran with different seeds, part of the difference would be luck. Because every random number in Bottleneck belongs to *who* and *what for* (D-003), running both scenarios with the **same seed** gives every person the same arrival time, speed and scan time in both. The only thing that differs is the number of lanes, so the difference is the effect of the lanes. This is called **common random numbers**, and it is why the comparison runs every scenario with the first scenario's seeds by default.

#### Confidence intervals over seeds
One seed is one possible evening. A **batch** runs the same scenario with several seeds (here up to 5, derived from the scenario's seed by a fixed hash, so the set is reproducible) and reports the mean with a **95% confidence interval**: mean ± t × sd / √n, where sd is the spread between seeds, n the number of seeds and t ≈ 2.78 for 5 seeds (Student t, because n is small). Read it as "if we could run many evenings, the true average would be in this range, with 95% confidence". With only 5 seeds the interval is wide; Phase 4 runs 20 or more on the server.

When two scenarios share their seeds, the comparison looks at the **difference per seed** (5 differences) and its confidence interval. Because both runs of a seed share the same people, much of the noise cancels, and the interval of the difference is much narrower than the two separate intervals. The page says "better" or "worse" only if that interval excludes 0; otherwise it says "no clear difference", which is an honest answer when the change is smaller than the noise.

#### Failing a lane by clicking, without breaking replay
A click is not part of the scenario, so a run that contains a click cannot be replayed from its scenario. Bottleneck therefore turns the click into data: "lane 2 fails at T−84:12.5" is added to a **working copy** of the scenario as a timed event, and the run is re-done from the start up to that moment. The result is exactly what the edited scenario gives, so it can be replayed, compared and saved like any other scenario.

#### Interview questions (Phase 2)

1. **Why validate with code generated at build time instead of Ajv at run time?**
   Ajv compiles schemas with `new Function`, which a strict CSP without `unsafe-eval` blocks. Generating the validator at build time keeps the strict CSP and still validates against the one shared schema; a test proves the generated code agrees with Ajv.

2. **What are common random numbers, and why do they matter for "3 vs 5 lanes"?**
   Running both scenarios with the same random numbers per person means the scenarios differ only in the change being tested. The difference between them then has far less noise than between two independently seeded runs, so a smaller sample gives a clear answer.

3. **Why is the comparison's verdict based on the paired differences, and what does "no clear difference" mean?**
   With shared seeds each seed gives one difference; their 95% confidence interval measures the effect directly and removes the noise both runs share. If that interval contains 0, the data cannot tell the scenarios apart, and saying "better" would be claiming more than was measured.

4. **How do you version data in localStorage when there is no migration framework?**
   Put the version in the key and in the stored document, store the schema version with every entry, and on load keep what matches, drop what does not with a visible notice and a backup copy. Never assume what is stored was written by the current build.

5. **How can a click during playback be "replayable"?**
   By not treating it as an action on the running simulation, but as an edit of its input: the click becomes a timed event in a copy of the scenario, and the run is recomputed from that input. Determinism then guarantees that every replay or comparison of the edited scenario gives the same result.

#### Estimating a scan time from a log
A scan log says *when* things happened, not how long a scan took. The idea: on a lane that is always busy, the time between two people leaving is exactly one service time, because the next person starts the moment the previous one is done. So the **inter-departure intervals of a busy lane are service times**. The trouble is idle time: when the lane waits for someone to arrive, the gap is an inter-arrival time and would inflate the estimate. The fitter therefore keeps only gaps up to 3 times the median gap of the whole group of lanes (the median is robust against a few long idle gaps), and skips the first departure after an idle gap and each lane's first one, which have no busy predecessor. A failed scan and its retry are one visit, so the result is the time the lane was busy per person. Long services are slightly underestimated (a gap that long may be thrown out as "idle"), and a group that is never busy gives inter-arrival times, so the estimate is biased high; on the busy 5-lane concert the fit is 4.42 s against a true 4.31 s (+2.7%). The test generates the log from the engine itself, so it checks the whole round trip: export, parse, fit, apply.

#### Interview question (scan logs)

6. **You only have timestamps of people leaving a gate. How do you estimate the service time, and when does it go wrong?**
   Use the intervals between consecutive departures on the same lane, but only while the lane was busy, because then each interval is one service time. Idle gaps are filtered out with a threshold relative to the median gap (here 3 times). It goes wrong on quiet lanes (the intervals are inter-arrival times, so the estimate is too high) and for very long services (they look like idle gaps and are dropped, so the estimate is slightly too low). The round-trip test (generate a log from the simulator, fit it, compare with the true mean, within 10%) shows the method is sound where it is meant to be used.

### Phase 3: cars, parking and departures, in plain language

#### The road graph and routing
Roads and parking aisles are drawn as polylines. The engine cuts them into **edges** wherever one ends at another or touches it within a metre, and cuts the last 30 m before each barrier as its own edge. That gives a directed graph: a node where roads meet, an edge for each stretch between them, with a length, a speed and a lane count. Every car needs "the quickest way from here to there". Instead of searching for each car, the engine computes the quickest travel time between **every pair** of edges once (a shortest-path search from each edge), and breaks ties in a fixed order (lowest edge id first), so the table is the same on every machine. A car's route is then a lookup: "from this edge, towards that target, which edge is next?". As with the pedestrian flow fields (Phase 1), the cost depends on the size of the network, not on the number of cars.

#### Car-following and spillback
Each edge lane keeps its cars **in order**. In every 0.25 s tick a car drives at the edge's free speed, but never closer than 7 m (4.5 m car plus 2.5 m gap) behind the car in front, and never past a stop line it must obey: a barrier it has not been served at, a crossing a pedestrian is on, or its target. It cannot enter the next edge unless that edge has room. A queue of cars therefore forms behind a barrier by itself, and grows backwards over the edges: when an edge is full, the next one fills, and so on up to the public road. That is **spillback**, and it is measured: the queue is the unbroken chain of held-up cars back from the stop line, and it ends at the first gap of more than 1.5 car spacings. It is a deliberately simple model (instant speed changes, no overtaking): enough to show where a queue ends up, not how smoothly it moves.

#### Reservations: how to avoid gridlock
A road with finite space and a lot with finite stalls can **deadlock**: car A waits for space that car B holds, and B waits for something A holds. The engine rules this out by reserving. **Road space:** a car enters an edge only if the edge has a free slot (length divided by 7 m), and the slot is then its own. **Stalls:** a car reserves its stall when it is admitted to the barrier's approach, and the barrier serves only cars that hold one. So nobody inside the lot is ever looking for space, and a full lot never blocks its own aisles: it shows up as an entry queue, or triggers the overflow rule (queue, divert once, leave). A waiting queue that can never be served (a lot with the queue rule and no departures) is caught by the watchdog, which ends the run with `deadlock: true` instead of running to the horizon.

#### Barriers are lanes
A barrier lane is a queueing server like a turnstile, so it uses the same `LaneBank`: a logical FIFO that starts when the car enters the approach (a car commits to the lane with the fewest committed cars), exact service events, retries after a plate misread, and Little's law checked on it too. One real-world detail changes the capacity: after a car leaves, the next one must drive from its place in the queue to the stop line, which takes about 1.25 s. So a lane with service time s serves about **1 / (s + 1.25 s)** cars per second, not 1 / s. The "time to empty" test uses exactly this: 60 cars at 12 s each give 720 s without the move-up and about 869 s with it, and the simulation gives 849 s.

#### Why plate recognition is not always better
Plate recognition has a lower mean service time than a ticket (7.1 against 7.5 s in our defaults). You would expect a shorter queue. But 5% of the cars are misread and take the fallback, 15 to 30 s. The **Pollaczek-Khinchine formula** (Phase 1) says the average wait is λ·E[S²] / (2(1 − ρ)): it depends on the **second moment** E[S²], which is large when a few services are very long. The misreads raise E[S²] a lot, even though they barely move the mean. At low utilisation ρ the queue is short anyway and the difference is lost in the noise; near the barrier's capacity (ρ close to 1, where the denominator 1 − ρ is small) the lower mean wins clearly. There is a second catch: with a 6 s parking manoeuvre in a single aisle, the aisle, not the barrier, is the bottleneck, so a faster barrier changes nothing. The test therefore uses a 1 s manoeuvre, over 10 paired seeds, and requires the 95% CI of the paired difference to exclude 0 (20.16 ± 8.64 m shorter on average). The lesson: a measure can make the average better and the queue worse, or not better at all; always look at the bottleneck and at the variation, not only at the mean.

#### Conservation with two kinds of agents
Conservation (Phase 1) says the states of all agents sum to the number created. With cars there are two kinds of agents, and the people in a car do not exist on the walking grid until they get out. So the engine keeps two counts: cars (Pending, Driving, Diverted, Parked, Departed, TurnedAway) and people. The occupants are **drawn when the car is created** (consecutive ids, so they are known), and are **Pending** until `carExitDelay` after the car parks. If the car is turned away, its occupants are `TurnedAway`: they never came, which is different from "unreachable" (nowhere to walk). Each count sums to its own total at every tick, and a test checks it on every example run.

#### Departures
A departure curve gives each group (a car's occupants are one group) a time to leave. People on foot walk back to where they came from, passing the gate lines without being scanned. People with a car walk to the lot's walking exit, and the driver first pays at the pay machines if the lot has them. When everyone is aboard, the car leaves after a boarding delay, picks the exit barrier with the lowest cost (driving time plus expected queue), and queues there. The **exit rush** is the result: a wave of cars meets a barrier whose capacity is about 1 / (s + 1.25 s) per lane. If drivers pay at the machines, the barrier's service is short (4 to 8 s) and the time to empty follows the departure curve and the machines; if they pay at the barrier, each car spends 25 to 45 s at the lane and the number of exit lanes decides everything (stand-alone example: 49 minutes with machines, 66 with payment at the barrier and 2 lanes, 49 again with 3 lanes).

#### Interview questions (Phase 3)

1. **Why compute all-pairs routes once instead of routing each car?**
   The cost then depends on the size of the network, not on the number of cars; every car's next step is a table lookup, and ties are broken in a fixed order, so the table is identical in every JavaScript engine. It is the same idea as the pedestrian flow fields.

2. **How do you stop cars deadlocking in a finite road network and a full car park?**
   By reserving before entering: a car takes road space only if an edge has a free slot, and a car is only served at the entry barrier if it already holds a stall. Nothing can then wait for space held by something that is waiting for it. A lot that is full shows up as an entry queue or an overflow rule, and a queue that can never clear is caught by the watchdog.

3. **Why is a barrier's capacity 1 / (s + 1.25 s) and not 1 / s?**
   After each service the next car must drive up to the stop line, which takes about 1.25 s during which the lane serves nobody. The time to empty for N cars is therefore about N·(s + 1.25 s) plus walking and driving, which the test checks (849 s measured against about 869 s expected for N = 60, s = 12 s).

4. **Plate recognition has a lower mean service time, but did not always give a shorter queue. Why?**
   The wait depends on the second moment E[S²] (Pollaczek-Khinchine), and the 5% misreads at 15 to 30 s make it large. At low utilisation the queue is short anyway; near capacity the lower mean wins. In a single aisle with a 6 s parking manoeuvre the aisle is the bottleneck, so the barrier does not matter. The test isolates the effect (1 s manoeuvre, 10 paired seeds, a CI that excludes 0).

5. **Occupants of a car only exist as walking people after it parks. How is conservation still exact?**
   They are created with the car (consecutive ids, drawn at creation) and held as Pending, so people are conserved from the start; cars have their own state counts that sum to the number of cars. A turned-away car turns its occupants into TurnedAway, not into unreachable people. Two counts, each exact at every tick, checked on every example.

---

## 8. Reference

### Repository layout
```
.github/workflows/ci.yml   CI: job `check` (schema check, lint, typecheck, test, build) and job `e2e` (Playwright)
apps/web/                  Vite + React + Tailwind site; engine runs in src/engine.worker.ts
apps/web/src/render/       PixiJS renderer; src/sim/ holds the controller, checkpoints, camera; src/ui/ the React components
apps/web/src/library/      scenario library logic: storage, editor form, validation, files, catalogue (pure, tested)
apps/web/src/compare/      comparison and batch logic: seeds and jobs, measures and differences, table rows, chart data, worker pool
apps/web/src/scanlog/      applying a fitted scan log to a new scenario
apps/web/src/validation/   build-time (Ajv standalone) scenario validator, served as virtual:scenario-validator (D-033)
apps/web/e2e/              Playwright tests (determinism, smoke, replay, compare, library) and record-demo (media recording, skipped unless RECORD_DEMO=1)
packages/engine/           simulation engine (pure TS) and its tests in test/
packages/analysis/         statistics (mean and 95% CI, paired differences) and scan-log generation, import and fitting, with tests
packages/examples/         built-in venues (venues/: Belgrade Fair fair day and concert with car parks, a stand-alone car park) and scenarios (scenarios/) as JSON, plus their tests in test/
packages/schema/           generated types (src/generated) and schema tests
schema/                    JSON Schema source files and shared fixtures
tools/                     scripts (schema type generator)
docs/PROJECT.md            this document
docs/spec/                 the specification and review notes
docs/media/                README demo GIF and screenshot (recorded by apps/web/e2e/record-demo.spec.ts)
vercel.json                Vercel build settings and security headers
playwright.config.ts       Playwright setup (production build under the production CSP, one worker)
```

### Commands
| Command | What it does |
|---|---|
| `npm install` | install everything (all workspaces) |
| `npm run dev` | web app dev server on http://localhost:5173 |
| `npm run build` then `npm run preview` | production build, served with the production security headers on http://localhost:4173 |
| `npm test` | all unit and validation tests (Vitest), including the example runs |
| `npm run test:e2e` | Playwright browser tests (Chromium; builds the app and serves it with `vite preview`). Run `npx playwright install chromium` once first. Not part of `npm run check`; CI runs it as a separate job |
| `RECORD_DEMO=1 npx playwright test record-demo` | records the README demo video and screenshots into `RECORD_DEMO_DIR` (default `./demo-out`); convert to a GIF with ffmpeg. Skipped without `RECORD_DEMO=1` |
| `npx vitest run packages/examples` | only the example scenarios (about 26 s, including the car scenarios); set `EXAMPLE_RUNS_VERBOSE=1` to print their numbers and `EXAMPLE_RUNS_ONLY=cars` (or `concert`, `fair`) to run a subset |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run schema:gen` | regenerate types after editing `/schema` |
| `npm run check` | everything the CI `check` job runs (not the browser tests) |
