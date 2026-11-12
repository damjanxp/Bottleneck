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

_Last updated: 2026-11-12_

| | |
|---|---|
| **Current phase** | Phase 1: pedestrian simulation, nearly complete (milestones 1a to 1e built; see [section 6](#phase-1-pedestrian-simulation)). Phase 0 is built and CI is green. |
| **Next phase** | Phase 2: scenarios and comparison |
| **Live demo** | Vercel (the owner imported the repository on 2026-11-11); every push to `main` deploys |
| **CI** | GitHub Actions: schema check, lint, typecheck, unit and validation tests, build on every push; a second job runs the Playwright browser tests (Chromium) |
| **How the work is done** | Work is orchestrated with subagents: the main agent plans and reviews, and subagents do focused pieces (code, tests, docs). Everything lands on a `phase-N` branch and passes `npm run check` before merging. |

**What exists after Phase 1** (on the `phase-1` branch, not yet merged to `main`):
- **Pedestrian engine:** walkable grid, flow fields, density and Weidmann speed, lane choice, spillback, jockeying, scan failures with a manual lane, timed lane failures, groups, bag policy, checkpoints, and the run metrics (decisions D-014 to D-031).
- **Examples** (`packages/examples`): two Belgrade Fair venues and six scenarios, each run headless in a test that checks the qualitative outcome ("3 lanes jam, 5 lanes cope").
- **Simulation view** (`apps/web`): the page loads the concert example, runs the engine in a Web Worker, draws the crowd with PixiJS, and shows state counts, lane queues, headline numbers, charts and the assumed parameters. Play, pause, speed, "Jump to peak", seeking, density heatmap and the `?perf=1` overlay.
- **Playwright tests in CI** (`apps/web/e2e`): the Node-versus-Chrome metrics hash test and a smoke test of the real page under the production CSP.

**Remaining before Phase 1 is closed:** the two [human] checks in [section 4](#phase-1-pedestrian-simulation-on-a-built-in-venue) (measured performance on the reference machine, and the "jam within 2 minutes" look at the live demo), the merge of `phase-1` into `main`, and a final review pass of the web UI by the owner.

### What the owner needs to do now

1. **Phase 0's [human] check, and again after the Phase 1 merge:** once `phase-1` is merged to `main`, open the Vercel URL, confirm that the page loads the concert example and that the "Engine self-check" line says **✓ Match: bit-identical to Node**. Send me the URL and I'll add it here and to the README.
2. **Phase 1's two [human] checks** are described in [section 4](#phase-1-pedestrian-simulation-on-a-built-in-venue). In short: press Play on the live page and see a queue form; run with `?perf=1` and send me the numbers.
3. **Optional: upgrade Node.js** on your machine to 24 LTS (you have 20.19, which reached end of life in April 2026). Everything works on 20.19 for now, but some newer tools, such as Vitest 5, already require 22 or later.

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

### D-022 TurnedAway means "unreachable" in Phase 1, and `carShare` is ignored until Phase 3
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

### Scan logs (pending)
_The scan-log decisions (format, fitting method, the 10% recovery test) are added by the orchestrator from the `@bottleneck/analysis` work._

---

## 3. Review notes triage

What happened to each point in [keep-in-mind.md](spec/keep-in-mind.md). "Adopt" means it will be done as suggested; the phase is where.

| # | Point (short) | Decision | Where |
|---|---|---|---|
| A1 | Fixed rules scattered across sections | **Adopt**: consolidated list in [section 5](#5-fixed-rules-consolidated) | done |
| A2 | Not every invariant can be a pure [test] | **Adopt**: section 5 marks each rule [test], [lint] or [human] | done |
| A3 | `Diverted`: state or counter? | **Adopt**: a car may be redirected **once** (counted as an event); if the second lot is also full it becomes `TurnedAway`. `Diverted` stays in the enum as the state of a car driving to its second lot. | Phase 3 |
| A4 | Occupants created at parking break conservation | **Adopt**: occupants are drawn when the car is created and held as `Pending` until they get out | Phase 3 |
| A5 | Phase tests listed under the wrong phase | **Adopt**: re-sorted in [section 4](#4-acceptance-checklist) | done |
| A6 | Scenarios before the backend; timed failures need the timeline; roads before the editor | **Adopt**: localStorage plus JSON export/import (Phase 2); timed lane failure is scenario data from Phase 1; Phase 3 roads are hand-written JSON | Phases 1–2 done (D-032, D-033); roads in Phase 3 |
| A7 | 20k+5k vs 10k+2k agents | **Adopt**: 20,000 pedestrians + 5,000 cars is the **soft cap** (warning in the UI); 10,000 + 2,000 is the **performance reference** scenario | Phase 1 |
| A8 | Performance target is Expected but gates a [human] check | **Adopt**: the [human] check *reports* the measured numbers; missing the target is recorded with a plan and does not block the phase | Phase 1/3 |
| A9 | "Jam within 2 minutes" unrealistic at 1× | **Adopt**: examples open at 30×, with a "Jump to peak" button, a callout on the worst lane and a one-click "+1 lane" that opens the comparison | done: Phase 1 (30×, Jump to peak, worst lane); Phase 2 "+1 lane" opens the comparison (D-036) |
| B1 | Shared PRNG breaks common random numbers | **Adopt**: D-003 | done |
| B2 | Lanes idle up to 0.25 s per service | **Adopt**: D-004 | done |
| B3 | Wq starts only when joining the queue area | **Adopt**: a logical FIFO per lane begins when the agent **commits** to the lane (wherever it is standing); Wq, L and λ are measured per lane-visit, and spilled-back agents count | done in Phase 1 (D-014, D-019; `queueWait` is also reported) |
| B4 | Weidmann divides by zero / freezes at ρmax | **Adopt**: v = v₀ below ρ = 0.1 /m², and a floor of 0.1·v₀ | done in Phase 1 (`density.ts`, tested in `runParts.test.ts`) |
| B5 | Run end and "time until empty" when overloaded | **Adopt**: `timeline.horizon`, a `drained` flag, and a deadlock watchdog; cars reserve road space or a stall before entering | Phase 1 done (`horizon`, `drained`, watchdog: D-023); cars in Phase 3 |
| B6 | Test criteria that pass for the wrong reason | **Adopt**: M/D/1 and M/G/1 pass only if the 95% CI from 20 seeds contains the theoretical value **and** the CI half-width is under 3% of it; P-K uses the implemented E[S] and E[S²]; seeds pinned; setups stated (lane-failure test: about 85% utilisation before the failure); queue length excludes the person in service | Phase 1 done (`queueing.test.ts`, D-012); cars in Phase 3 |
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
| E4 | Bag-policy field; car share per preset | **Adopt**: bag policy (none / clear bag / full search) sets screening time (Phase 1); car share fair 55%, concert 35%, stadium 30% (Phase 3) | bag policy done in Phase 1 (D-024); car share in Phase 3 |
| E5 | Payment defaults pessimistic | **Adopt**: card/cash mix for pay-at-barrier and pay stations | Phase 3 |
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
- [ ] [test] A generated scan log, re-imported, recovers the mean scan time within 10%
- [ ] [human] README with a GIF, the live link and the how-it-works notes. **First CV milestone.**

### Phase 3: Vehicles and parking
- [ ] [test] A parked car produces exactly its occupant count as pedestrians
- [ ] [test] Over 10 paired seeds, plate recognition gives a lower mean entry queue than ticket entry, and the 95% CI of the paired difference excludes 0
- [ ] [test] Departure with N cars and one exit lane as the bottleneck (service time s): time to empty is at least N·s and within 10% of N·s plus walking and driving time
- [ ] [test] A full lot applies its overflow rule; turned-away cars are counted; conservation holds
- [ ] [test] An entry queue reaching the public-road boundary is recorded with its time
- [ ] [test] Little's law and conservation hold for barriers, pay stations and cars too

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
- **Built:** everything in the plan. The web app now has four sections: Simulate, Scenarios, Compare, Scan logs (D-036).
- **Tests:** Vitest for all new logic (`apps/web/src/library/library.test.ts`, `compare/compare.test.ts`, `scanlog/scanlog.test.ts`: storage, form round trip, schema validity of editor output, the build-time validator against Ajv, import/export, seeds, differences in words, paired CIs, chart alignment, applying a fit). Playwright: `compare.spec.ts` (the Phase 2 acceptance check), `library.spec.ts` (create, save, reload, JSON export and import, scan-log export, import, fit and apply), and the updated `replay.spec.ts` ("+1 lane" opens the comparison).
- **Measured** (development machine, production build in Chrome): 2 concert runs compared in about 2.3 s (2 workers); a 5-seed batch of the 3-lane concert in about 6.3 s (4 workers). In headless Chromium with the map visible the 2-run comparison took about 10 s.
- **Example:** 3 vs 5 lanes, seed 1: still outside at the start 1,312 → 177 people; p95 wait in the peak arrival hour 27 min 10 s → 2 min 1 s. Over 5 seeds the 3-lane concert gives 1,295 ± 39 people outside at the start (mean ± 95% CI).
- **Deferred:** README with a GIF and the live link (the [human] check, after the merge). Undo in the editor (Phase 5, review C4). Editing custom arrival points by hand (only via the JSON box or a fitted scan log).
- **Known limitations:** scenarios live in one browser until Phase 4; a lane event recorded late in a run costs a re-run up to that moment; the fitted service time includes scan retries, so it slightly overstates the pure scan time when scan failures are on.

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
apps/web/e2e/              Playwright tests (determinism, smoke, replay, compare, library)
packages/engine/           simulation engine (pure TS) and its tests in test/
packages/examples/         built-in Belgrade Fair venues (venues/) and scenarios (scenarios/) as JSON, plus their tests in test/
packages/schema/           generated types (src/generated) and schema tests
schema/                    JSON Schema source files and shared fixtures
tools/                     scripts (schema type generator)
docs/PROJECT.md            this document
docs/spec/                 the specification and review notes
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
| `npx vitest run packages/examples` | only the example scenarios; set `EXAMPLE_RUNS_VERBOSE=1` to print their numbers and `EXAMPLE_RUNS_ONLY=concert` to run a subset |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run schema:gen` | regenerate types after editing `/schema` |
| `npm run check` | everything the CI `check` job runs (not the browser tests) |
