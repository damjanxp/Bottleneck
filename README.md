# Bottleneck

A browser-based simulator that shows where a venue's entrances and car parks will jam **before the event happens**.

Draw the site over a map, place pedestrian gates, security lanes, vehicle barriers and parking, enter how many people and cars you expect, and watch the queues form. Then change something (add a lane, break a gate, swap the barrier type) and compare the results side by side.

> **Status:** Phase 0 (foundation) is done: deterministic engine core, shared JSON Schema, CI and static deployment. The simulation view arrives in Phase 1. See [docs/PROJECT.md](docs/PROJECT.md) for the full status, decisions and roadmap.

## How it's built

- **Engine:** pure TypeScript, with no DOM and no network. The same code runs in a Web Worker in the browser and headless in Node, and gives **bit-identical results** in both. It uses counter-based randomness, in-repo `ln`/`exp`, and an exact-time event queue inside a fixed 0.25 s tick.
- **Web:** Vite + React + TypeScript + Tailwind, deployed as a static site with a strict Content-Security-Policy.
- **Schema:** venue, scenario and run formats are written once as JSON Schema in [`/schema`](schema). Types are generated from them, and CI fails if they are stale.
- **Later:** an ASP.NET Core (.NET 10) API with PostgreSQL for sharing, plus server-side batch runs and lane sweeps (Phase 4).

## Run it locally

Requires Node.js 20.19 or newer (24 LTS recommended).

```bash
npm install
npm run dev        # http://localhost:5173
npm run check      # everything CI runs: schema check, lint, typecheck, tests, build
```

## Documentation

Everything lives in **[docs/PROJECT.md](docs/PROJECT.md)**: status, decisions, the acceptance checklist, and plain-language "how it works" notes for each phase. The original specification is in [docs/spec](docs/spec).

All default parameters (walking speed, scan times, barrier times…) are **assumptions, not measurements**, and are labelled as such in the app.
