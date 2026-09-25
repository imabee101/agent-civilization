/**
 * Adaptive pacing. Measures how fast the brain answers and decides how
 * often nodes get model turns. This only changes *when* a node's model is
 * consulted, never what the node may do.
 */
import type { PacingMode, PacingStats } from "../shared/protocol";

export interface PacingConfig {
  /** Base wall-clock ms per tick at speed 1. */
  tickMs: number;
  /** Desired ticks between two turns of the same node when the brain is fast enough. */
  turnIntervalTicks: number;
  /** Max brain calls in flight. Local single-GPU setups want 1. */
  concurrency: number;
}

const ALPHA = 0.2;

export class Pacing {
  readonly cfg: PacingConfig;
  avgLatencyMs = 0;
  lastLatencyMs = 0;
  avgTokensPerSec = 0;
  avgTickCpuMs = 0;
  decisions = 0;
  sandboxCalls = 0;
  inFlight = 0;
  queued = 0;
  private readonly decisionTimes: number[] = [];
  private readonly startedAt = Date.now();

  constructor(cfg: PacingConfig) {
    this.cfg = cfg;
  }

  recordDecision(latencyMs: number, tokensPerSec: number, now = Date.now()): void {
    this.decisions++;
    this.lastLatencyMs = latencyMs;
    this.avgLatencyMs = this.avgLatencyMs === 0 ? latencyMs : this.avgLatencyMs * (1 - ALPHA) + latencyMs * ALPHA;
    if (tokensPerSec > 0) this.avgTokensPerSec = this.avgTokensPerSec === 0 ? tokensPerSec : this.avgTokensPerSec * (1 - ALPHA) + tokensPerSec * ALPHA;
    this.decisionTimes.push(now);
    const cutoff = now - 60_000;
    while (this.decisionTimes.length && this.decisionTimes[0]! < cutoff) this.decisionTimes.shift();
  }

  recordTickCpu(ms: number): void {
    this.avgTickCpuMs = this.avgTickCpuMs === 0 ? ms : this.avgTickCpuMs * (1 - ALPHA) + ms * ALPHA;
  }

  decisionsPerMin(now = Date.now()): number {
    const cutoff = now - 60_000;
    return this.decisionTimes.filter((t) => t >= cutoff).length;
  }

  /** Wall-clock ms one tick takes at the given speed. */
  tickMsAt(speed: number): number {
    return this.cfg.tickMs / speed;
  }

  /**
   * Ticks between turns of the same node, given how many nodes need turns.
   * If the brain can serve everyone within the desired interval, use it;
   * otherwise stretch the interval so the queue never grows without bound.
   */
  effectiveTurnInterval(livingNodes: number, speed: number): number {
    const desired = this.cfg.turnIntervalTicks;
    if (this.avgLatencyMs <= 0 || livingNodes === 0) return desired;
    const msPerRound = (this.avgLatencyMs * livingNodes) / Math.max(1, this.cfg.concurrency);
    const ticksPerRound = Math.ceil(msPerRound / this.tickMsAt(speed));
    return Math.max(desired, ticksPerRound);
  }

  mode(livingNodes: number, speed: number): PacingMode {
    if (livingNodes === 0) return "idle";
    return this.effectiveTurnInterval(livingNodes, speed) > this.cfg.turnIntervalTicks ? "queued" : "realtime";
  }

  stats(opts: { livingNodes: number; speed: number; paused: boolean; now?: number }): PacingStats {
    const now = opts.now ?? Date.now();
    return {
      mode: opts.paused ? "idle" : this.mode(opts.livingNodes, opts.speed),
      tps: opts.paused ? 0 : 1000 / this.tickMsAt(opts.speed),
      speed: opts.speed,
      paused: opts.paused,
      avgLatencyMs: Math.round(this.avgLatencyMs),
      lastLatencyMs: Math.round(this.lastLatencyMs),
      avgTokensPerSec: Math.round(this.avgTokensPerSec * 10) / 10,
      inFlight: this.inFlight,
      queued: this.queued,
      decisions: this.decisions,
      decisionsPerMin: this.decisionsPerMin(now),
      turnIntervalTicks: this.effectiveTurnInterval(opts.livingNodes, opts.speed),
      avgTickCpuMs: Math.round(this.avgTickCpuMs * 100) / 100,
      sandboxCalls: this.sandboxCalls,
      uptimeMs: now - this.startedAt,
    };
  }
}
