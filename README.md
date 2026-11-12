# Bottleneck

A browser-based simulator that shows where a venue's entrances and car parks will jam **before the event happens**.

Draw the site over a map, place pedestrian gates, security lanes, vehicle barriers and parking, enter how many people and cars you expect, and watch the queues form. Then change something (add a lane, break a gate, swap the barrier type) and compare the results side by side.

> **Status:** Phase 1 (pedestrian simulation) is nearly complete: the engine simulates walking, density-dependent speed, lane choice, queues that spill back, lane failures and scan retries, and the web page shows it live (PixiJS, in a Web Worker) on two built-in Belgrade Fair examples, a concert and a fair day. Node and Chrome give bit-identical results, checked in CI. Still open: the owner's performance and live-demo checks and the merge to `main`. See [docs/PROJECT.md](docs/PROJECT.md) for the full status, decisions and roadmap.

## How it's built

- **Engine:** pure TypeScript, with no DOM and no network. The same code runs in a Web Worker in the browser and headless in Node, and gives **bit-identical results** in both. It uses counter-based randomness, in-repo `ln`/`exp`, and an exact-time event queue inside a fixed 0.25 s tick.
- **Web:** Vite + React + TypeScript + Tailwind, deployed as a static site with a strict Content-Security-Policy. The simulation view draws the crowd with PixiJS from snapshots sent by the engine's Web Worker.
- **Examples:** [`packages/examples`](packages/examples) holds the built-in venues and scenarios as schema-valid JSON; a test simulates each one and checks that, for example, 3 lanes jam and 5 lanes cope.
- **Schema:** venue, scenario and run formats are written once as JSON Schema in [`/schema`](schema). Types are generated from them, and CI fails if they are stale.
- **Later:** an ASP.NET Core (.NET 10) API with PostgreSQL for sharing, plus server-side batch runs and lane sweeps (Phase 4).

## Run it locally

Requires Node.js 20.19 or newer (24 LTS recommended).

```bash
npm install
npm run dev        # http://localhost:5173
npm run check      # schema check, lint, typecheck, unit and validation tests, build
```

Browser tests (Playwright, Chromium) run against the production build and check that Node and Chrome's Web Worker give the same metrics hash, and that the page loads and plays under the strict Content-Security-Policy:

```bash
npx playwright install chromium   # once
npm run test:e2e                  # builds, serves with `vite preview`, runs the tests
```

CI runs both: `npm run check` and `npm run test:e2e` (as a separate job).

## Documentation

Everything lives in **[docs/PROJECT.md](docs/PROJECT.md)**: status, decisions, the acceptance checklist, and plain-language "how it works" notes for each phase. The original specification is in [docs/spec](docs/spec).

All default parameters (walking speed, scan times, barrier times…) are **assumptions, not measurements**, and are labelled as such in the app.
