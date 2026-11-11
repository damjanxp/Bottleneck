/**
 * Renderer extrapolation between snapshots (review note C3). Snapshots arrive ~20 times per
 * wall-clock second and carry velocities, so below 10× the renderer moves each agent along its
 * velocity for the simulated time since the snapshot. At 10× and above it draws the latest
 * snapshot as-is (agents jump too far between snapshots for extrapolation to look right).
 */

import { SNAPSHOT_FIELDS, TICK_SECONDS } from "@bottleneck/engine";

export const EXTRAPOLATE_BELOW_SPEED = 10;
/** Snapshots are expected this often (wall-clock seconds). */
export const SNAPSHOT_INTERVAL = 0.05;

/**
 * Simulated seconds to extrapolate by, given wall seconds since the snapshot arrived.
 * Capped at the simulated time between two expected snapshots (at least one tick) so that a
 * stalled worker never sends agents flying off.
 */
export function extrapolationSeconds(wallElapsed: number, speed: number, playing: boolean): number {
  if (!playing || speed >= EXTRAPOLATE_BELOW_SPEED || !(wallElapsed > 0)) return 0;
  const cap = Math.max(TICK_SECONDS, SNAPSHOT_INTERVAL * speed * 1.5);
  return Math.min(wallElapsed * speed, cap);
}

/** Position of agent i, `dt` simulated seconds after the snapshot. Writes into `out` [x, y]. */
export function agentPosition(snapshot: Float32Array, agentCount: number, i: number, dt: number, out: [number, number]): void {
  const n = agentCount;
  const x = snapshot[i] as number;
  const y = snapshot[n + i] as number;
  if (dt === 0) {
    out[0] = x;
    out[1] = y;
    return;
  }
  out[0] = x + (snapshot[2 * n + i] as number) * dt;
  out[1] = y + (snapshot[3 * n + i] as number) * dt;
}

export function snapshotAgentCount(snapshot: Float32Array): number {
  return Math.floor(snapshot.length / SNAPSHOT_FIELDS);
}
