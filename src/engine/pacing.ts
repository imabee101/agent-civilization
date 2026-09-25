/**
 * Adaptive pacing. Measures how fast the brain answers and decides how
 * often nodes get model turns. This only changes *when* a node's model is
 * consulted, never what the node may do.
 */
import type { BackendKind, BackendTimings, PacingMode, PacingStats, TurnWindow } from "../shared/protocol";

export interface PacingConfig {
  /** Base wall-clock ms per tick at speed 1. */
  tickMs: number;
  /** Desired ticks between two turns of the same node when the brain is fast enough. */
  turnIntervalTicks: number;
  /** The most brain calls ever in flight. The level actually used is measured (see `concurrency` on Pacing). */
  concurrency: number;
  /**
   * Longest a tick may be stretched so a slow brain still reaches every node
   * within `turnIntervalTicks`. 0 keeps the clock fixed and stretches the turn
   * interval instead. Per-tick physics are the same either way; this decides
   * whether a slow brain costs wall-clock time or turns per lifetime.
   */
  maxTickMs: number;
}

const ALPHA = 0.2;
/** Turns measured at a concurrency level before the controller judges it. */
export const TRIAL_TURNS = 6;
/** The level above must beat the current one by this factor to be kept. */
const BETTER_BY = 1.1;
/** After this many turns at a level, the level above is tried again in case the backend got faster. */
const RETRY_UPPER_EVERY = 30;

/**
 * How soon a node's next turn is due, relative to the base interval. Hot: something
 * happened to it (a message, a word heard, a new error, a body threshold, a
 * structure underfoot it had not seen). Cold: nothing changed since its last turn.
 * A scheduling detail only: it never changes what a node may do.
 */
export type Urgency = "hot" | "warm" | "cold";
export const SALIENCE: Record<Urgency, number> = { hot: 0.5, warm: 1, cold: 3 };

/** Ticks after a turn started before the next one is due, never less than one. */
export function dueIn(interval: number, urgency: Urgency): number {
  return Math.max(1, Math.ceil(interval * SALIENCE[urgency]));
}

export interface TurnOutcome {
  at: number;
  latencyMs: number;
  tokens: number;
  cut: boolean;
  error: boolean;
  timings?: BackendTimings;
}
const WINDOW_MS = 60 * 60 * 1000;

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
  private readonly inFlightSince: number[] = [];
  private readonly decisionTimes: number[] = [];
  private readonly startedAt = Date.now();
  /**
   * Concurrency controller. The level in use is measured, never guessed: per level, the
   * moving average of one stream's output rate over its whole turn (prefill included);
   * a level's throughput is that rate times the level. Hill-climb from 1 while the
   * backend is bandwidth-bound; a fast backend, or one that keeps up in real time, gets
   * the ceiling.
   */
  private level = 1;
  /** Unset until a probe or real timings classified the backend; until then nothing is governed. */
  private backendKind: BackendKind | undefined;
  private readonly levelRate: number[] = [];
  private turnsAtLevel = 0;
  private sinceUpperTrial = 0;
  /** Backend timings, moving averages. */
  prefillTps = 0;
  decodeTps = 0;
  cacheHit = 0;
  /** Every turn of the last hour: how long, how many tokens, where the time went, how it ended. */
  private readonly turns: TurnOutcome[] = [];

  constructor(cfg: PacingConfig) {
    this.cfg = cfg;
  }

  /** The number of turns to run at once right now. */
  get concurrency(): number {
    return this.governed ? Math.min(this.level, this.ceiling) : this.ceiling;
  }

  get ceiling(): number {
    return Math.max(1, this.cfg.concurrency);
  }

  /** False until the backend was measured, and when it is fast or keeps up with the world clock: then nothing is governed and the ceiling applies. */
  get governed(): boolean {
    return this.backendKind === "bandwidth-bound" && !this.keepsUp();
  }

  /** A turn that finishes inside one turn interval of wall-clock time needs no governing. */
  keepsUp(): boolean {
    return this.avgLatencyMs > 0 && this.avgLatencyMs <= this.cfg.turnIntervalTicks * this.cfg.tickMs;
  }

  setBackendKind(kind: BackendKind): void {
    this.backendKind = kind;
  }

  /** Throughput a level measured, output tokens per second across its streams; undefined until it has been tried. */
  levelThroughput(level: number): number | undefined {
    const r = this.levelRate[level];
    return r === undefined ? undefined : r * level;
  }

  /** The level with the best measured throughput so far. */
  get bestConcurrency(): number {
    let best = 1;
    for (let l = 1; l <= this.ceiling; l++) if ((this.levelThroughput(l) ?? -1) > (this.levelThroughput(best) ?? -1)) best = l;
    return best;
  }

  /** One turn's outcome, kept for an hour. Errors at the brain are turns too: they cost time and produced nothing. */
  recordOutcome(o: TurnOutcome): void {
    this.turns.push(o);
    const cutoff = o.at - WINDOW_MS;
    while (this.turns.length && this.turns[0]!.at < cutoff) this.turns.shift();
  }

  window(livingNodes: number, now = Date.now()): TurnWindow {
    const cutoff = now - WINDOW_MS;
    const turns = this.turns.filter((t) => t.at >= cutoff);
    const n = turns.length;
    const q = (xs: number[], p: number) => {
      if (!xs.length) return 0;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
    };
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const spanMs = n ? Math.max(1, Math.min(WINDOW_MS, now - Math.min(...turns.map((t) => t.at)))) : 1;
    const timed = turns.filter((t) => t.timings);
    return {
      turns: n,
      turnsPerNodePerHour: n && livingNodes ? Math.round(((n / livingNodes) * 3_600_000) / spanMs * 10) / 10 : 0,
      latencyP50Ms: Math.round(q(turns.map((t) => t.latencyMs), 0.5)),
      latencyP90Ms: Math.round(q(turns.map((t) => t.latencyMs), 0.9)),
      prefillSec: Math.round(mean(timed.map((t) => t.timings!.promptMs)) / 100) / 10,
      decodeSec: Math.round(mean(timed.map((t) => t.timings!.outputMs)) / 100) / 10,
      outputTokens: Math.round(mean(turns.map((t) => t.tokens))),
      cutRate: n ? Math.round((turns.filter((t) => t.cut).length / n) * 100) / 100 : 0,
      errorRate: n ? Math.round((turns.filter((t) => t.error).length / n) * 100) / 100 : 0,
    };
  }

  recordTimings(t: BackendTimings): void {
    const ema = (avg: number, v: number) => (avg === 0 ? v : avg * (1 - ALPHA) + v * ALPHA);
    const fresh = t.promptTokens - t.cachedTokens;
    if (t.promptMs > 0 && fresh > 0) this.prefillTps = ema(this.prefillTps, (fresh * 1000) / t.promptMs);
    if (t.outputMs > 0 && t.outputTokens > 0) this.decodeTps = ema(this.decodeTps, (t.outputTokens * 1000) / t.outputMs);
    if (t.promptTokens > 0) this.cacheHit = ema(this.cacheHit, t.cachedTokens / t.promptTokens);
  }

  /**
   * One turn finished. `turn` says how many output tokens it produced and at which
   * concurrency level it was dispatched; that is what the controller learns from.
   */
  recordDecision(latencyMs: number, tokensPerSec: number, now = Date.now(), turn?: { tokens: number; level: number }): void {
    this.decisions++;
    this.lastLatencyMs = latencyMs;
    this.avgLatencyMs = this.avgLatencyMs === 0 ? latencyMs : this.avgLatencyMs * (1 - ALPHA) + latencyMs * ALPHA;
    if (tokensPerSec > 0) this.avgTokensPerSec = this.avgTokensPerSec === 0 ? tokensPerSec : this.avgTokensPerSec * (1 - ALPHA) + tokensPerSec * ALPHA;
    this.decisionTimes.push(now);
    const cutoff = now - 60_000;
    while (this.decisionTimes.length && this.decisionTimes[0]! < cutoff) this.decisionTimes.shift();
    if (turn && latencyMs > 0 && turn.tokens > 0) this.learn(turn.level, (turn.tokens * 1000) / latencyMs);
  }

  private learn(level: number, streamRate: number): void {
    const prev = this.levelRate[level];
    this.levelRate[level] = prev === undefined ? streamRate : prev * (1 - ALPHA) + streamRate * ALPHA;
    if (level !== this.level) return;
    this.turnsAtLevel++;
    this.sinceUpperTrial++;
    if (this.turnsAtLevel < TRIAL_TURNS) return;
    const here = this.levelThroughput(this.level) ?? 0;
    const above = this.level < this.ceiling ? this.levelThroughput(this.level + 1) : undefined;
    const below = this.level > 1 ? this.levelThroughput(this.level - 1) : undefined;
    // The level below measured better: go back down. Otherwise try the level above when it is untested,
    // measured better, or has not been tried for a while (the backend may have changed underneath).
    if (below !== undefined && below > here) this.level--;
    else if (this.level < this.ceiling && (above === undefined || above > here * BETTER_BY || this.sinceUpperTrial >= RETRY_UPPER_EVERY)) {
      this.level++;
      this.sinceUpperTrial = 0;
    }
    this.turnsAtLevel = 0;
  }

  beginDecision(startedAt = Date.now()): void {
    this.inFlightSince.push(startedAt);
    this.inFlight = this.inFlightSince.length;
  }

  endDecision(startedAt: number): void {
    const i = this.inFlightSince.indexOf(startedAt);
    if (i >= 0) this.inFlightSince.splice(i, 1);
    this.inFlight = this.inFlightSince.length;
  }

  /**
   * Latency to plan with: the moving average, or longer when a call in flight
   * has already outlived it. Before the first decision completes the average
   * is 0, and without this the clock would run unpaced through the whole
   * first turn.
   */
  latencyEstimate(now = Date.now()): number {
    const oldest = this.inFlightSince.length ? now - Math.min(...this.inFlightSince) : 0;
    return Math.max(this.avgLatencyMs, oldest);
  }

  recordTickCpu(ms: number): void {
    this.avgTickCpuMs = this.avgTickCpuMs === 0 ? ms : this.avgTickCpuMs * (1 - ALPHA) + ms * ALPHA;
  }

  decisionsPerMin(now = Date.now()): number {
    const cutoff = now - 60_000;
    return this.decisionTimes.filter((t) => t >= cutoff).length;
  }

  /** Wall-clock ms one tick takes at the given speed, stretched up to `maxTickMs` while the brain is the bottleneck. */
  tickMsAt(speed: number, livingNodes = 0, now = Date.now()): number {
    const base = this.cfg.tickMs / speed;
    const latency = this.latencyEstimate(now);
    if (this.cfg.maxTickMs <= base || latency <= 0 || livingNodes === 0) return base;
    const needed = (latency * livingNodes) / this.concurrency / this.cfg.turnIntervalTicks;
    return Math.min(Math.max(base, needed), this.cfg.maxTickMs);
  }

  /**
   * Ticks between turns of the same node, given how many nodes need turns.
   * If the brain can serve everyone within the desired interval, use it;
   * otherwise stretch the interval so the queue never grows without bound.
   */
  effectiveTurnInterval(livingNodes: number, speed: number, now = Date.now()): number {
    const desired = this.cfg.turnIntervalTicks;
    const latency = this.latencyEstimate(now);
    if (latency <= 0 || livingNodes === 0) return desired;
    const msPerRound = (latency * livingNodes) / this.concurrency;
    const ticksPerRound = Math.ceil(msPerRound / this.tickMsAt(speed, livingNodes, now));
    return Math.max(desired, ticksPerRound);
  }

  mode(livingNodes: number, speed: number): PacingMode {
    if (livingNodes === 0) return "idle";
    if (this.effectiveTurnInterval(livingNodes, speed) > this.cfg.turnIntervalTicks) return "queued";
    return this.tickMsAt(speed, livingNodes) > this.cfg.tickMs / speed ? "paced" : "realtime";
  }

  stats(opts: { livingNodes: number; speed: number; paused: boolean; now?: number }): PacingStats {
    const now = opts.now ?? Date.now();
    return {
      mode: opts.paused ? "idle" : this.mode(opts.livingNodes, opts.speed),
      tps: opts.paused ? 0 : 1000 / this.tickMsAt(opts.speed, opts.livingNodes),
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
      concurrency: this.concurrency,
      concurrencyCeiling: this.ceiling,
      governed: this.governed,
      prefillTps: Math.round(this.prefillTps * 10) / 10,
      decodeTps: Math.round(this.decodeTps * 10) / 10,
      cacheHit: Math.round(this.cacheHit * 100) / 100,
      bestConcurrency: this.bestConcurrency,
      window: this.window(opts.livingNodes, now),
    };
  }
}
