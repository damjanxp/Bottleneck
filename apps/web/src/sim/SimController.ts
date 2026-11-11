/**
 * Main-thread side of the engine worker: sends commands, keeps the latest snapshot for the
 * renderer (returning the previous buffer to the worker), and fans out stats to the UI.
 */

import type { Scenario, Venue } from "@bottleneck/schema";
import type { LoadedInfo, MetricsSummary, StatsMessage, WorkerRequest, WorkerResponse } from "../workerProtocol.ts";

export interface Snapshot {
  buffer: Float32Array;
  agentCount: number;
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
  onError?(message: string): void;
}

export class SimController {
  private readonly worker: Worker;
  private readonly listeners = new Set<ControllerListener>();
  private generation = -1;
  private nextSeekId = 1;
  private seekState: SeekState | null = null;
  latest: Snapshot | null = null;
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
  seek(time: number): void {
    const seekId = this.nextSeekId++;
    this.setSeek({ seekId, target: time, fraction: 0 });
    this.send({ type: "seek", time, seekId });
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
        this.latest = { buffer: msg.buffer, agentCount: msg.agentCount, time: msg.time, receivedAt };
        this.bytesWindow.push({ at: receivedAt, bytes: msg.buffer.byteLength });
        if (previous) this.send({ type: "returnBuffer", buffer: previous.buffer, generation: this.generation }, [previous.buffer.buffer]);
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
        if (this.seekState && msg.seekId === this.seekState.seekId) this.setSeek(null);
        break;
      case "error":
        this.emit((l) => l.onError?.(msg.message));
        break;
      case "selfCheckResult":
        break;
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.worker.terminate();
  }
}
