import { describe, expect, it } from "vitest";
import { EventQueue, PlaybackPacer, Simulation, TICK_SECONDS, type EventHandler } from "../src/index.ts";

describe("EventQueue", () => {
  it("pops in (time, kind, id, insertion) order regardless of push order", () => {
    const q = new EventQueue<string>();
    q.push(2, 0, 0, "t2");
    q.push(1, 1, 5, "t1 kind1 id5");
    q.push(1, 1, 3, "t1 kind1 id3");
    q.push(1, 0, 9, "t1 kind0");
    q.push(1, 1, 3, "t1 kind1 id3 second");
    q.push(0.5, 7, 0, "t0.5");
    const order: string[] = [];
    for (let e = q.pop(); e; e = q.pop()) order.push(e.payload);
    expect(order).toEqual(["t0.5", "t1 kind0", "t1 kind1 id3", "t1 kind1 id3 second", "t1 kind1 id5", "t2"]);
  });

  it("sorts a large shuffled set correctly", () => {
    const q = new EventQueue<number>();
    const times: number[] = [];
    let x = 12345;
    for (let i = 0; i < 5000; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      const t = (x % 1000) / 7;
      times.push(t);
      q.push(t, 0, 0, i);
    }
    const popped: number[] = [];
    for (let e = q.pop(); e; e = q.pop()) popped.push(e.time);
    expect(popped).toEqual([...times].sort((a, b) => a - b));
  });

  it("rejects non-finite times", () => {
    expect(() => new EventQueue().push(NaN, 0, 0, null)).toThrow(RangeError);
    expect(() => new EventQueue().push(Infinity, 0, 0, null)).toThrow(RangeError);
  });
});

describe("Simulation tick loop", () => {
  const KIND = 1;

  it("keeps a fixed 0.25 s tick and an exact clock", () => {
    const sim = new Simulation(new Map());
    for (let i = 0; i < 4 * 3600; i++) sim.step();
    expect(TICK_SECONDS).toBe(0.25);
    expect(sim.tick).toBe(14400);
    expect(sim.now).toBe(3600); // exact, no drift
  });

  it("handles events at their exact time, not rounded to the tick", () => {
    const seen: number[] = [];
    const handler: EventHandler<null> = (_e, s) => seen.push(s.now);
    const sim = new Simulation(new Map([[KIND, handler]]));
    sim.schedule(0.1, KIND, 0, null);
    sim.schedule(3.1, KIND, 0, null);
    sim.runUntil(5);
    expect(seen).toEqual([0.1, 3.1]);
  });

  it("drains chained events inside the same tick (no idle time between services)", () => {
    // A lane serving 0.1 s jobs back to back: 10 jobs must finish at 0.1, 0.2, ... 1.0 s,
    // not one per tick.
    const finished: number[] = [];
    let remaining = 10;
    const complete: EventHandler<null> = (_e, s) => {
      finished.push(s.now);
      remaining--;
      if (remaining > 0) s.schedule(s.now + 0.1, KIND, 0, null);
    };
    const sim = new Simulation(new Map([[KIND, complete]]));
    sim.schedule(0.1, KIND, 0, null);
    sim.runUntil(1.25);
    expect(finished.length).toBe(10);
    finished.forEach((t, i) => expect(t).toBeCloseTo((i + 1) * 0.1, 12));
    // All ten finished within the first 5 ticks (1.25 s).
    expect(sim.tick).toBe(5);
  });

  it("runs tick systems after the tick's events, in registration order, at the tick end", () => {
    const log: string[] = [];
    const handler: EventHandler<string> = (e) => log.push(`event ${e.payload}`);
    const sim = new Simulation<string>(new Map([[KIND, handler]]), [
      { name: "a", update: (s) => log.push(`a@${s.now}`) },
      { name: "b", update: (s) => log.push(`b@${s.now}`) },
    ]);
    sim.schedule(0.25, KIND, 0, "on the boundary");
    sim.schedule(0.2, KIND, 0, "early");
    sim.step();
    expect(log).toEqual(["event early", "event on the boundary", "a@0.25", "b@0.25"]);
  });

  it("refuses to schedule into the past or an unknown kind", () => {
    const sim = new Simulation(new Map([[KIND, () => {}]]));
    sim.runUntil(10);
    expect(() => sim.schedule(9, KIND, 0, null)).toThrow(RangeError);
    expect(() => sim.schedule(11, 99, 0, null)).toThrow(RangeError);
  });
});

describe("PlaybackPacer", () => {
  it("runs 4 ticks per real second at 1x and 240 at 60x", () => {
    expect(new PlaybackPacer(1).ticksFor(1)).toBe(4);
    expect(new PlaybackPacer(60).ticksFor(1)).toBe(240);
  });

  it("carries fractional ticks so the long-run pace is exact", () => {
    const pacer = new PlaybackPacer(1);
    let total = 0;
    for (let frame = 0; frame < 600; frame++) total += pacer.ticksFor(1 / 60); // 10 s at 60 fps
    expect(total).toBe(40);
  });

  it("clamps speed to 1x..60x and caps catch-up work", () => {
    expect(new PlaybackPacer(500).speed).toBe(60);
    expect(new PlaybackPacer(0).speed).toBe(1);
    const pacer = new PlaybackPacer(60, 100);
    expect(pacer.ticksFor(10)).toBe(100);
    expect(pacer.ticksFor(0)).toBe(0);
  });
});
