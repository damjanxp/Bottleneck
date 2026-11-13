/**
 * Main-thread side of the engine worker: sends commands, keeps the latest snapshot for the
 * renderer (returning the previous buffer to the worker), and fans out stats to the UI.
 */

import type { Scenario, Venue } from "@bottleneck/schema";
import type { LoadedInfo, MetricsSummary, StatsMessage, WorkerRequest, WorkerResponse } from "../workerProtocol.ts";

export interface Snapshot {
  buffer: Float32Array;
  agentCount: number;
  /** Cars, VehicleSnapshotField layout (empty without cars). */
  vehicles: Float32Array;
  vehicleCount: number;
  /** Scenario time of the snapshot. */
  time: number;
  /** performance.now() when it arrived. */
  receivedAt: number;
}

export interface SeekState {
  seekId: number;
  target: number;
  fraction: number;
}

export interface ControllerListener {
  onLoaded?(info: LoadedInfo): void;
  onSnapshot?(snapshot: Snapshot): void;
  onStats?(stats: StatsMessage): void;
  onMetrics?(metrics: MetricsSummary): void;
  onSeek?(seek: SeekState | null): void;
  /** A seek finished (or was cancelled); durationMs is the worker's wall time for it. */
  onSeekDone?(done: { seekId: number; cancelled: boolean; time: number; durationMs: number }): void;
  onError?(message: string): void;
}

export class SimController {
  private readonly worker: Worker;
  private readonly listeners = new Set<ControllerListener>();
  private generation = -1;
  private nextSeekId = 1;
  private nextRequestId = 1;
  private readonly scanLogWaiters = new Map<number, (r: { csv: string; rows: number }) => void>();
  private seekState: SeekState | null = null;
  latest: Snapshot | null = null;
  /** Wall time of the last completed seek (ms), for the perf overlay. */
  lastSeekMs: number | null = null;
  loaded: LoadedInfo | null = null;
  /** Snapshot bytes received, for the perf overlay. */
  private bytesWindow: { at: number; bytes: number }[] = [];

  constructor() {
    this.worker = new Worker(new URL("../engine.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handle(event.data);
    this.worker.onerror = (event) => this.emit((l) => l.onError?.(event.message || "Worker error"));
  }

  subscribe(listener: ControllerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(f: (l: ControllerListener) => void): void {
    for (const l of this.listeners) f(l);
  }

  private send(msg: WorkerRequest, transfer?: Transferable[]): void {
    this.worker.postMessage(msg, transfer ?? []);
  }

  load(venue: Venue, scenario: Scenario, speed: number): void {
    this.latest = null;
    this.loaded = null;
    this.setSeek(null);
    this.send({ type: "load", venue, scenario, speed });
  }
  play(): void {
    this.send({ type: "play" });
  }
  pause(): void {
    this.send({ type: "pause" });
  }
  step(ticks: number): void {
    this.send({ type: "step", ticks });
  }
  restart(): void {
    this.setSeek(null);
    this.send({ type: "restart" });
  }
  setSpeed(speed: number): void {
    this.send({ type: "setSpeed", speed });
  }
  setDensity(enabled: boolean): void {
    this.send({ type: "setDensity", enabled });
  }
  /** Starts a seek and returns its id. */
  seek(time: number): number {
    const seekId = this.nextSeekId++;
    this.setSeek({ seekId, target: time, fraction: 0 });
    this.send({ type: "seek", time, seekId });
    return seekId;
  }
  /** Swaps in an edited scenario (a recorded lane or lot event) and replays exactly to `time`; returns the seek id. */
  replaceScenario(scenario: Scenario, time: number): number {
    const seekId = this.nextSeekId++;
    this.setSeek({ seekId, target: time, fraction: 0 });
    this.send({ type: "replaceScenario", scenario, time, seekId });
    return seekId;
  }
  /** Asks the worker for the current run's scan log as CSV. */
  scanLog(): Promise<{ csv: string; rows: number }> {
    const requestId = this.nextRequestId++;
    const p = new Promise<{ csv: string; rows: number }>((resolve) => this.scanLogWaiters.set(requestId, resolve));
    this.send({ type: "scanLog", requestId });
    return p;
  }
  cancelSeek(): void {
    this.send({ type: "cancelSeek" });
  }

  get seeking(): SeekState | null {
    return this.seekState;
  }

  /** Snapshot bytes per second over the last 2 s. */
  snapshotBytesPerSecond(now = performance.now()): number {
    this.bytesWindow = this.bytesWindow.filter((e) => now - e.at <= 2000);
    let sum = 0;
    for (const e of this.bytesWindow) sum += e.bytes;
    return sum / 2;
  }

  private setSeek(s: SeekState | null): void {
    this.seekState = s;
    this.emit((l) => l.onSeek?.(s));
  }

  private handle(msg: WorkerResponse): void {
    switch (msg.type) {
      case "loaded":
        this.generation = msg.generation;
        this.loaded = msg;
        this.latest = null;
        this.emit((l) => l.onLoaded?.(msg));
        break;
      case "snapshot": {
        if (msg.generation !== this.generation) return; // stale size: let the buffer go
        const previous = this.latest;
        const receivedAt = performance.now();
        this.latest = { buffer: msg.buffer, agentCount: msg.agentCount, vehicles: msg.vehicles, vehicleCount: msg.vehicleCount, time: msg.time, receivedAt };
        this.bytesWindow.push({ at: receivedAt, bytes: msg.buffer.byteLength + msg.vehicles.byteLength });
        if (previous) {
          const transfer: Transferable[] = [previous.buffer.buffer];
          if (previous.vehicles.length > 0) transfer.push(previous.vehicles.buffer);
          this.send({ type: "returnBuffer", buffer: previous.buffer, vehicles: previous.vehicles, generation: this.generation }, transfer);
        }
        const latest = this.latest;
        this.emit((l) => l.onSnapshot?.(latest));
        break;
      }
      case "stats":
        if (msg.generation !== this.generation) return;
        this.emit((l) => l.onStats?.(msg));
        break;
      case "metrics":
        if (msg.generation !== this.generation) return;
        this.emit((l) => l.onMetrics?.(msg.metrics));
        break;
      case "seekProgress":
        if (this.seekState && msg.seekId === this.seekState.seekId) this.setSeek({ ...this.seekState, fraction: msg.fraction });
        break;
      case "seekDone":
        if (msg.generation !== this.generation) return;
        if (!msg.cancelled) this.lastSeekMs = msg.durationMs;
        if (this.seekState && msg.seekId === this.seekState.seekId) this.setSeek(null);
        this.emit((l) => l.onSeekDone?.({ seekId: msg.seekId, cancelled: msg.cancelled, time: msg.time, durationMs: msg.durationMs }));
        break;
      case "error":
        this.emit((l) => l.onError?.(msg.message));
        break;
      case "scanLog": {
        const resolve = this.scanLogWaiters.get(msg.requestId);
        this.scanLogWaiters.delete(msg.requestId);
        resolve?.({ csv: msg.csv, rows: msg.rows });
        break;
      }
      case "selfCheckResult":
        break;
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.worker.terminate();
  }
}
