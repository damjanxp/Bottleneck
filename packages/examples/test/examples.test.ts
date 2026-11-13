import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { SCHEMA_FILES, type Point } from "@bottleneck/schema";
import { exampleVenues } from "../src/index.ts";

const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../schema");
const ajv = new Ajv({ allErrors: true, strict: true, strictTuples: false });
addFormats.default(ajv);
for (const file of SCHEMA_FILES) ajv.addSchema(JSON.parse(readFileSync(path.join(schemaDir, file), "utf8")) as object, file);
const validator = (file: string): ValidateFunction => ajv.getSchema(file) as ValidateFunction;

type Ring = Point[];
interface Poly {
  outer: Ring;
  holes?: Ring[];
}

function inRing(p: Point, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const inPoly = (p: Point, poly: Poly): boolean => inRing(p, poly.outer) && !(poly.holes ?? []).some((h) => inRing(p, h));

describe("example venues", () => {
  it("have unique ids", () => {
    const venueIds = exampleVenues.map((e) => e.venue.id);
    expect(new Set(venueIds).size).toBe(venueIds.length);
    const scenarioIds = exampleVenues.flatMap((e) => e.scenarios.map((s) => s.id));
    expect(scenarioIds.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
  });

  for (const ex of exampleVenues) {
    const v = ex.venue;
    describe(v.name, () => {
      it("venue is valid against the schema", () => {
        const validate = validator("venue.schema.json");
        expect(validate(v), JSON.stringify(validate.errors, null, 2)).toBe(true);
      });

      it("element ids are unique", () => {
        const ids = [
          ...[...v.walkableAreas, ...v.obstacles, ...v.sources, ...v.screeningStages, ...v.gateGroups, ...v.destinations].map((e) => e.id),
          ...[...(v.roads ?? []), ...(v.vehicleSources ?? []), ...(v.vehicleBarriers ?? []), ...(v.parkingLots ?? []), ...(v.crossings ?? [])].map((e) => e.id),
          ...(v.parkingLots ?? []).flatMap((l) => (l.payStation ? [l.payStation.id] : [])),
        ];
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("sources lie in walkable area and outside obstacles", () => {
        for (const s of v.sources) {
          expect(v.walkableAreas.some((w) => inPoly(s.position, w.polygon)), s.id).toBe(true);
          expect(v.obstacles.some((o) => inPoly(s.position, o.polygon)), s.id).toBe(false);
        }
      });

      it("gate and screening lines have both endpoints in free walkable area", () => {
        for (const g of [...v.gateGroups, ...v.screeningStages]) {
          for (const p of [g.line.a, g.line.b]) {
            expect(v.walkableAreas.some((w) => inPoly(p, w.polygon)), g.id).toBe(true);
            expect(v.obstacles.some((o) => inPoly(p, o.polygon)), g.id).toBe(false);
          }
        }
      });

      it("destinations are in walkable area, on the inside (left-hand side) of gate lines; sources outside", () => {
        for (const d of v.destinations) {
          const c = d.area.outer[0] as Point;
          expect(v.walkableAreas.some((w) => inPoly(c, w.polygon)), d.id).toBe(true);
        }
        for (const g of v.gateGroups) {
          const mid = { x: (g.line.a.x + g.line.b.x) / 2, y: (g.line.a.y + g.line.b.y) / 2 };
          const n = { x: -(g.line.b.y - g.line.a.y), y: g.line.b.x - g.line.a.x }; // inside normal
          for (const d of v.destinations) {
            const c = d.area.outer[0] as Point;
            expect((c.x - mid.x) * n.x + (c.y - mid.y) * n.y, `${g.id} -> ${d.id}`).toBeGreaterThan(0);
          }
          for (const s of v.sources) {
            expect((s.position.x - mid.x) * n.x + (s.position.y - mid.y) * n.y, `${s.id} -> ${g.id}`).toBeLessThan(0);
          }
        }
      });

      it("vehicle element references exist", () => {
        const roads = new Set((v.roads ?? []).map((r) => r.id));
        const barriers = new Set((v.vehicleBarriers ?? []).map((b) => b.id));
        const lots = new Set((v.parkingLots ?? []).map((l) => l.id));
        for (const b of v.vehicleBarriers ?? []) expect(roads.has(b.roadId), b.id).toBe(true);
        for (const s of v.vehicleSources ?? []) if (s.lotId !== undefined) expect(lots.has(s.lotId), s.id).toBe(true);
        for (const l of v.parkingLots ?? []) {
          for (const id of [...l.entryBarrierIds, ...l.exitBarrierIds]) expect(barriers.has(id), `${l.id} ${id}`).toBe(true);
          // Walking exits and pay stations are on the walking grid.
          expect(v.walkableAreas.some((w) => inPoly({ x: l.walkingExit.x, y: l.walkingExit.y + 0.25 }, w.polygon)), l.id).toBe(true);
          if (l.payStation) for (const p of [l.payStation.line.a, l.payStation.line.b]) expect(v.walkableAreas.some((w) => inPoly(p, w.polygon)), l.payStation.id).toBe(true);
        }
      });

      it("screening stage references exist", () => {
        const stages = new Set(v.screeningStages.map((s) => s.id));
        for (const g of v.gateGroups) if (g.screeningStageId !== undefined) expect(stages.has(g.screeningStageId), g.id).toBe(true);
      });

      it("scenarios are valid and reference existing elements", () => {
        const validate = validator("scenario.schema.json");
        const groups = new Map(v.gateGroups.map((g) => [g.id, g]));
        const lots = new Set((v.parkingLots ?? []).map((l) => l.id));
        const elementIds = new Set([
          ...groups.keys(),
          ...v.screeningStages.map((s) => s.id),
          ...(v.vehicleBarriers ?? []).map((b) => b.id),
          ...lots,
          ...(v.parkingLots ?? []).flatMap((l) => (l.payStation ? [l.payStation.id] : [])),
        ]);
        const sources = new Set(v.sources.map((s) => s.id));
        expect(ex.scenarios.length).toBeGreaterThanOrEqual(2);
        for (const sc of ex.scenarios) {
          expect(validate(sc), `${sc.id}: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
          expect(sc.venueId).toBe(v.id);
          for (const key of Object.keys(sc.overrides ?? {})) expect(elementIds.has(key), `${sc.id} override ${key}`).toBe(true);
          for (const e of sc.timedEvents ?? []) {
            if (e.kind === "busBurst") expect(sources.has(e.sourceId), `${sc.id} ${e.sourceId}`).toBe(true);
            else if (e.kind === "lotClose") expect(lots.has(e.lotId), `${sc.id} ${e.lotId}`).toBe(true);
            else {
              const g = groups.get(e.groupId);
              expect(g, `${sc.id} ${e.groupId}`).toBeDefined();
              expect(e.laneIndex).toBeLessThan(sc.overrides?.[e.groupId]?.laneCount ?? g?.laneCount ?? 0);
            }
          }
        }
      });
    });
  }
});
