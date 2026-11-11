## 13. Keep in mind (review notes, not requirements)

Five independent reviews of v0.2 (simulation, frontend, backend/security, domain, delivery) turned up the points below. None of them are binding. They are suggestions and known weak spots. Use your judgment: adopt, adapt or reject each one, and for anything that changes the data model, simulation rules or API contract, write a short decision record (section 2) saying what you chose and why. If a point conflicts with a Fixed rule, keep the Fixed rule and flag the conflict in the phase summary.

### A. Contradictions and gaps in this spec to resolve early
- Section 2 says all Fixed rules are listed in section 7, but Fixed items also appear in sections 4.1, 4.5, 5, 8 and 11. Consider one consolidated list.
- Section 7.1 says every invariant has an automated test, but some (assumptions labelled, responsiveness) are partly [human].
- The agent state enum has `Diverted`, but section 4.3 also treats diverting as an action with no hop limit. Decide whether it is a terminal state or an event counter, and cap it at one redirect before `TurnedAway`.
- Car occupants are created at parking, which strains "agents per state sum to the number created". Consider drawing occupants at car creation and holding them as `Pending`.
- Phase tests are listed under the wrong phase in places (for example, pedestrian queueing and lane-failure tests are Phase 1 work; the "empty page is live" check is Phase 0). Re-sort them.
- Phase 2 needs scenarios saved before the backend exists (suggest localStorage plus JSON export/import). Phase 1's timed lane failure needs the timeline from 6.3, so it can start as scenario data. Phase 3 roads are hand-written JSON until the editor exists.
- The soft limit of 20,000 + 5,000 agents differs from the 10,000 + 2,000 performance reference. Say which is which.
- The performance target is Expected but is used as a gate in a [human] check. Align them.
- "Jam within 2 minutes of Play" is unrealistic at 1x because arrivals ramp over 90 minutes. Consider default example speed 30x, a "Jump to peak" button, a callout on the worst lane, and a one-click "+1 lane" fix that opens the comparison.

### B. Simulation correctness (highest-impact items)
- One shared PRNG breaks common random numbers: adding or failing a lane shifts every later draw. Consider counter-based randomness, a pure function of (seed, agent id, purpose, index), with all draws made at agent creation.
- With 0.25 s ticks, a lane can idle up to 0.25 s per service, which breaks D/D/1 tolerances. Consider draining all due events inside a tick in (time, kind, id) order, and starting service at max(predecessor completion, head-ready time). Treat stepping up the queue as visual only.
- Wq starts at "joining the queue", but spilled-back agents are outside the queue area, so waits are understated when the jam is worst. Consider a logical FIFO that starts when the agent commits to a lane, with Wq, L and λ measured per lane-visit.
- Weidmann divides by zero at ρ = 0 and gives zero or negative speed at ρmax, which can freeze a jam. Consider v = v₀ below a small density and a floor of about 0.1·v₀.
- Define run end and "time until empty" when demand exceeds capacity: a time horizon, a drained flag, and a deadlock watchdog. Cars should reserve space or a stall before entering.
- Test criteria that can pass for the wrong reason:
  - "Within 5% or the CI, whichever is larger" passes any noisy result.
  - The Pollaczek–Khinchine check must use E[S] and E[S²] of the distribution you actually implement.
  - Pin seeds, state the pre-failure utilisation for the lane-failure test, and state setups for the plate-vs-ticket and time-to-empty tests.
  - The queue-length definition should exclude the agent in service.
- Rescaling by a small factor changes a single-seed p95 by more than 2%. Check rescale on the mean of about 20 paired seeds. Translation can be bit-identical if the raster is anchored to the venue's bounding box.
- Hash a canonical Float64 byte dump, not JSON. Define p95 (nearest-rank). Record interactive lane failures as timestamped scenario events so scrubbing by re-run stays exact.

### C. Frontend and performance
- Replay memory: 12,000 agents × 1 keyframe/s blows the 200 MB cap in about 70 minutes of a 4-hour run. Consider an adaptive keyframe interval plus engine checkpoints every few simulated minutes, so backward seeks stay fast and cancellable.
- Budget the worker tick separately (suggest p95 under 12 ms at the reference load), since it is likelier to be the bottleneck than rendering.
- Interpolating 20 Hz snapshots at 8x spans about 1.6 simulated seconds. Consider sending velocity and extrapolating.
- For undo, an immutable document needs stored document references, not inverse commands. Pick one.
- Next.js adds little for a static, client-only app. Vite + React is simpler, and Next.js is fine if you want it on the CV.
- Accessibility and mobile: data-table alternatives for charts, keyboard access to editor tools, `aria-live` for the headline number, and canvas hidden by default under about 768 px.

### D. Backend and security
- Limit the job runner: one job at a time, a per-venue and global queue cap, a work budget (seeds × sweep points × simulated hours), and a per-run timeout. Create jobs only with the edit key.
- Specify the .NET-to-Node contract (suggest a stateless internal HTTP service). The database is the real queue; the `Channel<T>` is only a wake-up signal. Use a unique (venueId, requestId) index, reset Running jobs to Queued on startup, and record `engineVersion` with each result.
- A strict CSP should be Fixed, since XSS means edit-key theft. Use constant-time hash comparison, rotate keys atomically, and state that no cookies are used.
- Rate limiting behind Caddy needs forwarded headers configured. Give concrete limits and a global cap on venues and storage.
- Cap upload pixel counts from the header before decoding. Cap jsonb size and element counts. Validate before migrating and re-validate after. Check the ImageSharp licence.
- Add backup RPO/RTO, encryption of off-box backups, and include uploads in the backup.
- In the README, frame .NET as orchestration and persistence, since the Node sidecar runs the simulation.

### E. Domain realism and product value
- Report lane capacity in people per hour (lanes × 3600 / mean service time) next to peak demand, and mark where peak utilisation first falls below about 85%.
- Turnstile scans of about 4 s are slow. Consider card (about 3 s) vs phone QR (about 4.5 s) with an assumed 50/50 mix.
- Arrivals are too smooth. Consider groups of 1-5 that choose the same lane, and a late-arrival tail before the start (for example, about 20% of a concert in the last 15 minutes).
- Add a bag-policy scenario field (none, clear bag, full search). Make car share vary by preset (fair about 55%, concert about 35%, stadium about 30%).
- Pay-at-barrier (20-40 s) and pay-station (30-60 s) defaults look pessimistic for card payment. Consider a card/cash mix.
- Make "latest gate opening time for 95% inside by the start" the first line of the comparison view.
- In the README, tell readers to replace the assumed defaults with their own device's measured throughput.

### F. Process
- The per-phase plan, summary, learning notes and decision records add up to many documents. Consider limiting plans and learning notes to the phases with the most new design, and writing `docs/security.md` in Phase 4, when the app first goes public.
- If something must be cut, cut in this order: Phase 8, Phase 7, heatmap and scrubber, jockeying and logit choice, editor extras, VPS backups.
