/**
 * The static part of a run: the venue turned into what the simulation needs, computed once.
 *
 * - The walkable grid (geometry.ts) and a destination flow field.
 * - Lane elements: every screening stage and gate group, with scenario overrides applied.
 * - Lanes: `laneCount` lanes spaced evenly along each element's line (lane k of n sits at
 *   a + (b − a)·(k + 0.5)/n), plus one *manual lane* per gate group (see below).
 * - Stage sets: the groups of elements an agent chooses between at one point of its journey.
 *
 * Lane geometry. The inside of a line a→b is the side where cross(b − a, p − a) > 0, i.e. the
 * left-hand side in the usual maths orientation (in the venue's y-down picture it appears on the
 * right). Each lane has a service point on the line, an exit point 0.75 m inside, and a queue
 * area: slots 0.6 m apart going straight outwards for `queueLength` metres. Slot 0 is the head
 * of the line. The queue area is cut short where it would leave the walkable grid; it always has
 * at least one slot. Each lane has a flow field towards its tail slot (the back of the line).
 *
 * Manual lane (our modelling choice, spec 5 only says "sent to a manual lane"): one extra lane
 * per gate group, half a lane spacing beyond end `a` of the line, with the same queue geometry.
 * It serves people whose scan failed twice, with a uniform 20–40 s service time (assumed).
 * Nobody chooses it; people are sent there.
 *
 * Stage sets. Set 0 ("entry") holds every screening stage used by some gate group plus every gate
 * group without screening. For each screening stage there is one more set: the gate groups behind
 * it. Agents walk the set's flow field (towards the nearest lane tail of any element in the set)
 * until they are within the decision distance, then choose a lane.
 */

import type { Distribution, Point, Scenario, Venue } from "@bottleneck/schema";
import { buildFlowField, type FlowField } from "./flowField.ts";
import { buildWalkGrid, localFrame, localRings, toLocal, type LocalFrame, type WalkGrid } from "./geometry.ts";
import { distributionMoments } from "./sampling.ts";

export interface ModelSettings {
  slotSpacing: number;
  manualServiceTime: Distribution;
}

export interface LaneElement {
  readonly index: number;
  readonly id: string;
  readonly kind: "screening" | "gate";
  readonly laneCount: number;
  readonly queueLength: number;
  readonly serviceTime: Distribution;
  readonly scanFailureRate: number;
  readonly retryTime: Distribution | null;
  /** Expected time a lane is busy per person, including retries (for expected-wait estimates). */
  readonly meanService: number;
  /** Ids of the regular lanes, in lane-index order. */
  readonly laneIds: number[];
  /** Id of the manual lane (gate groups only), −1 otherwise. */
  readonly manualLaneId: number;
  /** For a screening stage: the stage set of the gate groups behind it. −1 otherwise. */
  readonly nextStageSet: number;
}

export interface LaneGeometry {
  readonly id: number;
  readonly element: number;
  /** Index within the element; the manual lane has index laneCount. */
  readonly laneIndex: number;
  readonly manual: boolean;
  /** Local coordinates. */
  readonly serviceX: number;
  readonly serviceY: number;
  readonly exitX: number;
  readonly exitY: number;
  /** Queue slots, head (index 0) first. */
  readonly slotX: Float64Array;
  readonly slotY: Float64Array;
  /** Number of slots in the physical queue area. */
  readonly capacity: number;
  /** How many people stand side by side when the line spills back. */
  readonly perRow: number;
  /** Flow field towards the tail slot. */
  readonly field: FlowField;
}

export interface StageSet {
  readonly elements: number[];
  /** Regular lane ids of all elements in the set. */
  readonly laneIds: number[];
  readonly field: FlowField;
}

export interface VenueModel {
  readonly frame: LocalFrame;
  readonly grid: WalkGrid;
  readonly elements: LaneElement[];
  readonly lanes: LaneGeometry[];
  readonly stageSets: StageSet[];
  readonly destinationField: FlowField;
  /** Spawn point (local) of each source, on a walkable cell. */
  readonly sourceX: Float64Array;
  readonly sourceY: Float64Array;
  readonly sourceShares: number[];
}

const EXIT_DEPTH = 0.75;

export function buildVenueModel(venue: Venue, scenario: Scenario, settings: ModelSettings): VenueModel {
  const frame = localFrame(venue);
  const grid = buildWalkGrid(venue, frame);
  const overrides = scenario.overrides ?? {};

  // Elements: screening stages first, then gate groups, each in venue order.
  const elements: LaneElement[] = [];
  const lanes: LaneGeometry[] = [];
  const pending: { element: number; line: { a: Point; b: Point } }[] = [];
  const usedScreening = new Set<string>();
  for (const g of venue.gateGroups) if (g.screeningStageId !== undefined) usedScreening.add(g.screeningStageId);

  const stageSets: { elements: number[] }[] = [{ elements: [] }];
  const screeningIndex: Record<string, number> = {};

  for (const s of venue.screeningStages) {
    const o = overrides[s.id] ?? {};
    const serviceTime = o.serviceTime ?? s.serviceTime;
    const index = elements.length;
    const used = usedScreening.has(s.id);
    const nextStageSet = used ? stageSets.length : -1;
    if (used) {
      stageSets.push({ elements: [] });
      stageSets[0]?.elements.push(index);
    }
    screeningIndex[s.id] = nextStageSet;
    elements.push({
      index,
      id: s.id,
      kind: "screening",
      laneCount: o.laneCount ?? s.laneCount,
      queueLength: s.queueLength,
      serviceTime,
      scanFailureRate: 0,
      retryTime: null,
      meanService: distributionMoments(serviceTime).mean,
      laneIds: [],
      manualLaneId: -1,
      nextStageSet,
    });
    pending.push({ element: index, line: s.line });
  }
  for (const g of venue.gateGroups) {
    const o = overrides[g.id] ?? {};
    const serviceTime = o.serviceTime ?? g.serviceTime;
    const rate = o.scanFailureRate ?? g.scanFailure.rate;
    const index = elements.length;
    const set = g.screeningStageId !== undefined ? (screeningIndex[g.screeningStageId] ?? 0) : 0;
    stageSets[set]?.elements.push(index);
    const s = distributionMoments(serviceTime).mean;
    const r = distributionMoments(g.scanFailure.retryTime).mean;
    elements.push({
      index,
      id: g.id,
      kind: "gate",
      laneCount: o.laneCount ?? g.laneCount,
      queueLength: g.queueLength,
      serviceTime,
      scanFailureRate: rate,
      retryTime: g.scanFailure.retryTime,
      meanService: s + rate * r,
      laneIds: [],
      manualLaneId: -1,
      nextStageSet: -1,
    });
    pending.push({ element: index, line: g.line });
  }

  // Lane geometry: regular lanes of every element first (so their ids are dense per element),
  // then the manual lanes.
  for (const { element, line } of pending) {
    const el = elements[element] as LaneElement;
    for (let k = 0; k < el.laneCount; k++) {
      const lane = buildLane(grid, frame, lanes.length, el, k, false, line, (k + 0.5) / el.laneCount, settings.slotSpacing);
      el.laneIds.push(lane.id);
      lanes.push(lane);
    }
  }
  for (const { element, line } of pending) {
    const el = elements[element] as LaneElement;
    if (el.kind !== "gate") continue;
    const lane = buildLane(grid, frame, lanes.length, el, el.laneCount, true, line, -0.5 / el.laneCount, settings.slotSpacing);
    (el as { manualLaneId: number }).manualLaneId = lane.id;
    lanes.push(lane);
  }

  const builtSets: StageSet[] = stageSets.map((set) => {
    const laneIds: number[] = [];
    const targets: number[] = [];
    for (const e of set.elements) {
      for (const id of (elements[e] as LaneElement).laneIds) {
        laneIds.push(id);
        const lane = lanes[id] as LaneGeometry;
        targets.push(grid.cellAt(lane.slotX[lane.capacity - 1] as number, lane.slotY[lane.capacity - 1] as number));
      }
    }
    return { elements: set.elements, laneIds, field: buildFlowField(grid, targets) };
  });

  // Destinations: every walkable cell inside any destination area.
  const destMask = new Uint8Array(grid.cellCount);
  const destTargets: number[] = [];
  for (const d of venue.destinations) {
    const before = destTargets.length;
    grid.fill(destMask, localRings(frame, d.area), 1);
    for (let i = 0; i < grid.cellCount; i++) {
      if (destMask[i] === 1) {
        destMask[i] = 0;
        if (grid.walkable[i] === 1) destTargets.push(i);
      }
    }
    if (destTargets.length === before && d.area.outer.length > 0) {
      // Destination drawn outside the walkable area: use the nearest walkable cell to its outline's mean.
      let sx = 0;
      let sy = 0;
      for (const p of d.area.outer) {
        const l = toLocal(frame, p);
        sx += l.x;
        sy += l.y;
      }
      const cell = grid.nearestWalkable(sx / d.area.outer.length, sy / d.area.outer.length);
      if (cell >= 0) destTargets.push(cell);
    }
  }
  const destinationField = buildFlowField(grid, destTargets);

  const sourceX = new Float64Array(venue.sources.length);
  const sourceY = new Float64Array(venue.sources.length);
  venue.sources.forEach((s, i) => {
    const p = toLocal(frame, s.position);
    if (grid.isWalkableAt(p.x, p.y)) {
      sourceX[i] = p.x;
      sourceY[i] = p.y;
    } else {
      const cell = grid.nearestWalkable(p.x, p.y);
      sourceX[i] = cell >= 0 ? grid.centreX(cell) : p.x;
      sourceY[i] = cell >= 0 ? grid.centreY(cell) : p.y;
    }
  });

  return {
    frame,
    grid,
    elements,
    lanes,
    stageSets: builtSets,
    destinationField,
    sourceX,
    sourceY,
    sourceShares: venue.sources.map((s) => s.share),
  };
}

/** True if the straight segment between two local points stays on walkable cells (sampled every 0.1 m). */
function segmentWalkable(grid: WalkGrid, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / 0.1));
  for (let s = 0; s <= steps; s++) {
    if (!grid.isWalkableAt(x0 + (dx * s) / steps, y0 + (dy * s) / steps)) return false;
  }
  return true;
}

function buildLane(grid: WalkGrid, frame: LocalFrame, id: number, el: LaneElement, laneIndex: number, manual: boolean, line: { a: Point; b: Point }, t: number, spacing: number): LaneGeometry {
  const a = toLocal(frame, line.a);
  const b = toLocal(frame, line.b);
  const lx = b.x - a.x;
  const ly = b.y - a.y;
  const len = Math.sqrt(lx * lx + ly * ly);
  // Unit inward normal: cross(b − a, n) > 0.
  const nx = len > 0 ? -ly / len : 1;
  const ny = len > 0 ? lx / len : 0;

  let sx = a.x + lx * t;
  let sy = a.y + ly * t;
  if (!grid.isWalkableAt(sx, sy)) {
    const cell = grid.nearestWalkable(sx, sy);
    if (cell < 0) throw new RangeError(`Lane ${laneIndex} of ${el.id} has no walkable cell nearby`);
    sx = grid.centreX(cell);
    sy = grid.centreY(cell);
  }

  let ex = sx;
  let ey = sy;
  for (const depth of [EXIT_DEPTH, EXIT_DEPTH / 2]) {
    if (segmentWalkable(grid, sx, sy, sx + nx * depth, sy + ny * depth)) {
      ex = sx + nx * depth;
      ey = sy + ny * depth;
      break;
    }
  }

  // Queue slots outwards (−n), cut short where the queue area leaves the walkable grid.
  const maxSlots = Math.max(1, Math.floor(el.queueLength / spacing));
  const xs: number[] = [];
  const ys: number[] = [];
  let px = sx;
  let py = sy;
  for (let k = 0; k < maxSlots; k++) {
    const qx = sx - nx * spacing * (k + 1);
    const qy = sy - ny * spacing * (k + 1);
    if (!segmentWalkable(grid, px, py, qx, qy)) break;
    xs.push(qx);
    ys.push(qy);
    px = qx;
    py = qy;
  }
  if (xs.length === 0) {
    xs.push(sx);
    ys.push(sy);
  }
  const capacity = xs.length;
  const width = el.laneCount > 0 ? len / el.laneCount : spacing;
  const tailCell = grid.cellAt(xs[capacity - 1] as number, ys[capacity - 1] as number);
  return {
    id,
    element: el.index,
    laneIndex,
    manual,
    serviceX: sx,
    serviceY: sy,
    exitX: ex,
    exitY: ey,
    slotX: Float64Array.from(xs),
    slotY: Float64Array.from(ys),
    capacity,
    perRow: Math.max(1, Math.floor(width / spacing)),
    field: buildFlowField(grid, [tailCell]),
  };
}
