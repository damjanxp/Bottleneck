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

_Last updated: 2026-11-11_

| | |
|---|---|
| **Current phase** | Phase 0: Foundation. Built; waiting for the live-page check. |
| **Next phase** | Phase 1: pedestrian simulation on the built-in Belgrade Fair venues |
| **Live demo** | Vercel, once the project is imported (see below) |
| **CI** | GitHub Actions: schema check, lint, typecheck, tests, build on every push |

### What the owner needs to do now

1. **Import the repository into Vercel** (one time): Vercel dashboard → *Add New… → Project* → import `damjanxp/Bottleneck`. Leave *Root Directory* as the repository root and the framework preset as "Other". `vercel.json` already sets the install command, build command, output folder and security headers. Every push to `main` then deploys automatically.
2. **Check the live page** (Phase 0's [human] check): open the Vercel URL and confirm that the "Engine self-check" card says **✓ Match: bit-identical to Node**. Send me the URL and I'll add it here and to the README.
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
| A6 | Scenarios before the backend; timed failures need the timeline; roads before the editor | **Adopt**: localStorage plus JSON export/import (Phase 2); timed lane failure is scenario data from Phase 1; Phase 3 roads are hand-written JSON | Phases 1–3 |
| A7 | 20k+5k vs 10k+2k agents | **Adopt**: 20,000 pedestrians + 5,000 cars is the **soft cap** (warning in the UI); 10,000 + 2,000 is the **performance reference** scenario | Phase 1 |
| A8 | Performance target is Expected but gates a [human] check | **Adopt**: the [human] check *reports* the measured numbers; missing the target is recorded with a plan and does not block the phase | Phase 1/3 |
| A9 | "Jam within 2 minutes" unrealistic at 1× | **Adopt**: examples open at 30×, with a "Jump to peak" button, a callout on the worst lane and a one-click "+1 lane" that opens the comparison | Phases 1–2 |
| B1 | Shared PRNG breaks common random numbers | **Adopt**: D-003 | done |
| B2 | Lanes idle up to 0.25 s per service | **Adopt**: D-004 | done |
| B3 | Wq starts only when joining the queue area | **Adopt**: a logical FIFO per lane begins when the agent **commits** to the lane (wherever it is standing); Wq, L and λ are measured per lane-visit, and spilled-back agents count | Phase 1 |
| B4 | Weidmann divides by zero / freezes at ρmax | **Adopt**: v = v₀ below ρ = 0.1 /m², and a floor of 0.1·v₀ | Phase 1 |
| B5 | Run end and "time until empty" when overloaded | **Adopt**: `timeline.horizon`, a `drained` flag, and a deadlock watchdog; cars reserve road space or a stall before entering | Phases 1, 3 |
| B6 | Test criteria that pass for the wrong reason | **Adopt**: M/D/1 and M/G/1 pass only if the 95% CI from 20 seeds contains the theoretical value **and** the CI half-width is under 3% of it; P-K uses the implemented E[S] and E[S²]; seeds pinned; setups stated (lane-failure test: about 85% utilisation before the failure); queue length excludes the person in service | Phases 1, 3 |
| B7 | Rescale check too noisy on one seed | **Adopt**: rescaling is checked on the mean of 20 paired seeds; translation must be bit-identical, with the raster anchored to the venue's bounding box | Phase 1 |
| B8 | Hash JSON vs bytes; p95 definition; interactive failures | **Adopt**: D-006 for the hash; p95 by nearest rank; interactive lane failures are recorded as timestamped scenario events, so replay by re-running stays exact | Phases 0–1 |
| C1 | Replay memory blows 200 MB | **Adopt**: adaptive keyframe interval plus engine checkpoints every few simulated minutes; backward seeks restore the nearest checkpoint and re-run, cancellably | Phase 1 |
| C2 | Budget the worker tick separately | **Adopt**: worker tick p95 under 12 ms at the reference load, shown in `?perf=1` | Phase 1 |
| C3 | 20 Hz snapshots too coarse at 8× | **Adopt**: snapshots carry velocity; the renderer extrapolates | Phase 1 |
| C4 | Undo: inverse commands vs immutable documents | **Adopt**: undo stores previous document references (cheap with structural sharing), not inverse commands | Phase 5 |
| C5 | Next.js adds little | **Adopt**: D-002 | done |
| C6 | Accessibility and mobile | **Adopt**: table alternatives for charts, keyboard-accessible editor tools, `aria-live` headline number, canvas hidden by default below about 768 px | Phases 1–6 |
| D1 | Limit the job runner | **Adopt**: one job at a time, per-venue and global queue caps, work budget (seeds × points × simulated hours), per-run timeout, jobs need the edit key | Phase 4 |
| D2 | .NET to Node contract | **Adopt**: a stateless internal HTTP sidecar; the database is the real queue (`Channel<T>` only wakes the runner); unique (venueId, requestId); Running→Queued on startup; `engineVersion` stored per result | Phase 4 |
| D3 | CSP, constant-time compare, atomic key rotation, no cookies | **Adopt**: CSP already in place (D-009); the rest in Phase 4 | Phases 0, 4 |
| D4 | Rate limits behind Caddy | **Adopt**: forwarded headers configured; concrete limits and global caps written down in Phase 4 | Phase 4 |
| D5 | Upload pixel caps, jsonb caps, validate around migrations, ImageSharp licence | **Adopt**; the licence is checked before use (fallback: SkiaSharp) | Phase 4 |
| D6 | Backups RPO/RTO, encryption, include uploads | **Adopt** | Phase 4 |
| D7 | README: .NET is orchestration and persistence | **Adopt** | Phase 4/6 |
| E1 | Capacity in people/hour next to peak demand; first time under 85% utilisation | **Adopt** | Phase 1 |
| E2 | Turnstile 4 s is slow: card 3 s vs QR 4.5 s, 50/50 | **Adopt** as the new assumed default (mixed distribution) | Phase 1 |
| E3 | Arrivals too smooth: groups of 1–5, late tail | **Adopt**: groups choose the same lane; concert preset gets ~20% of arrivals in the last 15 min | Phase 1 |
| E4 | Bag-policy field; car share per preset | **Adopt**: bag policy (none / clear bag / full search) sets screening time (Phase 1); car share fair 55%, concert 35%, stadium 30% (Phase 3) | Phases 1, 3 |
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
- [ ] [test] Two runs with the same seed give identical output
- [ ] [test] The same tiny scenario gives the same metrics hash in Node and in Chrome's Web Worker (Playwright)
- [ ] [test] D/D/1: at 80% utilisation the queue stays 0; at 125% the queue at time t equals (λ − μ)·t ± 1
- [ ] [test] M/D/1 at 70% utilisation, Poisson arrivals injected at one lane, 20 pinned seeds × 10 h after a 1 h warm-up: the 95% CI of mean Lq contains the theoretical 0.817 and its half-width is under 3% of it
- [ ] [test] M/G/1 with the implemented scan-time distribution at 80% utilisation: mean Wq matches Pollaczek–Khinchine using that distribution's E[S] and E[S²], by the same rule
- [ ] [test] Little's law (L = λW within 3%) and conservation (states sum to agents created) on every lane and snapshot of the example runs
- [ ] [test] Failing 2 of 4 lanes 30 min before the start (about 85% utilisation beforehand, pinned seed) raises the remaining lanes' maximum queue by at least 30% compared with the same seed without the failure
- [ ] [test] Translating the venue gives bit-identical metrics; rescaling by a small factor changes the mean over 20 paired seeds by less than 2%
- [ ] [human] The performance target in 7.2 is measured on the reference machine (10,000 pedestrians at 8×: frame p95 < 33 ms, worker tick p95 < 12 ms), and the numbers are recorded
- [ ] [human] The live demo loads the concert example and a jam forms within 2 minutes of pressing Play

### Phase 2: Scenarios and comparison
- [ ] [test] Comparing 3 vs 5 lanes on the concert example shows highlighted differences (Playwright)
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
| F3 | Exact (unrounded) service times as scheduled events; events drained in (time, kind, id) order within a tick (D-004) | 4.1 | [test] | ✅ core; lanes in Phase 1 |
| F4 | Counter-based seeded randomness (D-003); only exact arithmetic plus in-repo `ln`/`exp` (D-005); iteration ordered by id, never by Map/Set insertion | 4.1 | [lint] + [test] | ✅; ordering rule reviewed in code review |
| F5 | Snapshots ~20/s as structure-of-arrays Float32Array, Transferable, double-buffered, no SharedArrayBuffer, dropped if the renderer lags | 4.1 | [test] | Phase 1 |
| F6 | Metrics per lane and venue-wide as listed in 4.5 | 4.5 | [test] | Phases 1, 3 |
| F7 | Every default parameter editable, stored with every run, labelled "assumed" in the UI | 5, 7.1-7 | [test] + [human] | Phase 1 |
| F8 | Determinism: bit-identical metrics in Node (CI) and Chrome's Web Worker | 7.1-1 | [test] Playwright | self-check ✅; Playwright in Phase 1 |
| F9 | Geometry in metres; translation identical; small rescale < 2% | 7.1-2 | [test] | Phase 1 |
| F10 | Conservation of agents across states | 7.1-3 | [test] | Phase 1 |
| F11 | Physical rules: walkable areas only; one agent per lane; failed lane serves none | 7.1-4 | [test] | Phase 1 |
| F12 | Little's law within 3% on every lane | 7.1-5 | [test] | Phase 1 |
| F13 | No paid API required; AI draft off by default | 7.1-8 | [test] | Phase 8 |
| F14 | No secrets in the client or the repository | 7.1-9 | [CI] secret scan + review | Phase 4 adds a scanner |
| F15 | UI never freezes; engine off the main thread | 7.2 | [human] + [test] | Phase 1 |
| F16 | Validation tests (queueing family) and Little's law on every CI run | 7.2 | [CI] | Phase 1 |
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
- **Owner checks ([human]):** see [section 1](#what-the-owner-needs-to-do-now). Import into Vercel, open the URL, confirm the green "Match" line.

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

---

## 8. Reference

### Repository layout
```
.github/workflows/ci.yml   CI: schema check, lint, typecheck, test, build
apps/web/                  Vite + React + Tailwind site; engine runs in src/engine.worker.ts
packages/engine/           simulation engine (pure TS) and its tests in test/
packages/schema/           generated types (src/generated) and schema tests
schema/                    JSON Schema source files and shared fixtures
tools/                     scripts (schema type generator)
docs/PROJECT.md            this document
docs/spec/                 the specification and review notes
vercel.json                Vercel build settings and security headers
```

### Commands
| Command | What it does |
|---|---|
| `npm install` | install everything (all workspaces) |
| `npm run dev` | web app dev server on http://localhost:5173 |
| `npm run build` then `npm run preview` | production build, served with the production security headers on http://localhost:4173 |
| `npm test` | all unit tests (Vitest) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run schema:gen` | regenerate types after editing `/schema` |
| `npm run check` | everything CI runs |
