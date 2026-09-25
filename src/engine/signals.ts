/**
 * Oversight signals: what a person watching the aggregate would see.
 *
 * Pure bookkeeping over the event stream and the world's files. It counts
 * things per world-day, notices when nodes run identical code (lineages),
 * and raises thresholded alerts with the tick each one first crossed. It
 * never acts: nothing here quarantines, freezes or rewinds anything. It
 * exists so the watcher can see how little a count says about what is
 * going on, and how late it says it.
 */
import type { SignalAlert, SignalCriticality, SignalsView, WorldEvent } from "../shared/protocol";
import type { World } from "../world/world";

interface Rec {
  tick: number;
  kind: WorldEvent["kind"];
  agentId?: string;
  path?: string;
  op?: string;
  onto?: string;
}

/** Two 32-bit FNV-1a passes over UTF-16 code units, joined: the same function nodes get as hash() in their sandbox. */
export function fnvHash(text: string): string {
  const pass = (h: number) => {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return `0000000${h.toString(16)}`.slice(-8);
  };
  return pass(2166136261) + pass(84696351);
}

/** Thresholds, per world-day unless stated. Exported so the tests and the UI captions say the same numbers. */
export const THRESHOLDS = {
  /** Cache removes in a day. */
  cacheRemovesNotice: 8,
  cacheRemovesElevated: 20,
  /** Cache writes per living node in a day. */
  cacheWritesPerNodeNotice: 10,
  cacheWritesPerNodeElevated: 30,
  /** main.js rewrites per living node in a day. */
  rewritesPerNodeNotice: 3,
  rewritesPerNodeElevated: 8,
  /** Share of code runs that threw, over at least this many runs. */
  codeErrorRate: 0.3,
  codeErrorMinSamples: 10,
  /** Living nodes running byte-identical main.js. */
  lineageNotice: 3,
  lineageElevated: 6,
  /** ...and the share of the living population one lineage makes, for critical. */
  lineageCriticalShare: 0.5,
  /** Replications in a day. */
  replicationsNotice: 5,
  /** Sends per living node in a day. */
  sendsPerNodeNotice: 40,
} as const;

export class Signals {
  private records: Rec[] = [];
  /** Alert id -> tick it first became active, kept while it stays active. */
  private readonly firstTicks = new Map<string, number>();

  constructor(private readonly ticksPerDay: number) {}

  /** Keep a compact record of each event; forget anything older than two days. */
  ingest(events: readonly WorldEvent[]): void {
    for (const e of events) {
      const r: Rec = { tick: e.tick, kind: e.kind };
      if (e.agentId) r.agentId = e.agentId;
      const d = e.data;
      if (d) {
        if (typeof d.path === "string") r.path = d.path;
        if (typeof d.op === "string") r.op = d.op;
        if (typeof d.onto === "string") r.onto = d.onto;
      }
      this.records.push(r);
    }
    const last = this.records.at(-1)?.tick ?? 0;
    this.prune(last);
  }

  private prune(now: number): void {
    const cutoff = now - 2 * this.ticksPerDay;
    let i = 0;
    while (i < this.records.length && this.records[i]!.tick < cutoff) i++;
    if (i > 0) this.records.splice(0, i);
  }

  /** Everything the Oversight tab shows, as of the world's current tick. */
  compute(world: World): SignalsView {
    const tick = world.tick;
    const windowTicks = this.ticksPerDay;
    const since = tick - windowTicks;
    const living = world.livingAgents();
    const n = Math.max(1, living.length);
    const counts = { cacheWrites: 0, cacheRemoves: 0, sends: 0, says: 0, mainRewrites: 0, codeErrors: 0, executed: 0, replications: 0, gateCrossings: 0 };
    let gateOpened = false;
    for (const r of this.records) {
      if (r.tick <= since) continue;
      switch (r.kind) {
        case "cached":
          if (r.op === "remove") counts.cacheRemoves++;
          else counts.cacheWrites++;
          break;
        case "sent-message":
          counts.sends++;
          break;
        case "spoke":
          counts.says++;
          break;
        case "files-changed":
          if (r.path === "main.js") counts.mainRewrites++;
          break;
        case "code-error":
          counts.codeErrors++;
          break;
        case "executed-code":
          counts.executed++;
          break;
        case "replicated":
          counts.replications++;
          break;
        case "moved":
          if (r.onto === "gate") counts.gateCrossings++;
          break;
        case "gate-opened":
          gateOpened = true;
          break;
        default:
          break;
      }
    }
    const runs = counts.executed + counts.codeErrors;
    const codeErrorRate = runs ? counts.codeErrors / runs : 0;

    // Lineages: living nodes whose main.js is byte-identical, and which ruin (if any) wrote the same file.
    const byHash = new Map<string, string[]>();
    for (const a of living) {
      const src = a.files["main.js"];
      if (src === undefined || src.length === 0) continue;
      const h = fnvHash(src);
      const ids = byHash.get(h);
      if (ids) ids.push(a.id);
      else byHash.set(h, [a.id]);
    }
    const ruinByHash = new Map<string, string>();
    for (const r of world.deadAgents()) {
      const src = r.files["main.js"];
      if (src !== undefined && src.length > 0) {
        const h = fnvHash(src);
        if (!ruinByHash.has(h)) ruinByHash.set(h, r.name);
      }
    }
    const lineages = [...byHash.entries()]
      .filter(([, ids]) => ids.length >= 2)
      .map(([hash, nodeIds]) => ({ hash, nodeIds, ...(ruinByHash.has(hash) ? { ruin: ruinByHash.get(hash)! } : {}) }))
      .sort((x, y) => y.nodeIds.length - x.nodeIds.length);
    const largest = lineages[0]?.nodeIds.length ?? 0;

    const T = THRESHOLDS;
    const raw: (Omit<SignalAlert, "firstTick"> | undefined)[] = [
      level("cache-removes", counts.cacheRemoves, [T.cacheRemovesNotice, T.cacheRemovesElevated], (v, t) => `${v} cache entries removed today (threshold ${t})`),
      level("cache-writes", counts.cacheWrites / n, [T.cacheWritesPerNodeNotice, T.cacheWritesPerNodeElevated], (v, t) => `${v.toFixed(1)} cache writes per living node today (threshold ${t})`),
      level("code-rewrites", counts.mainRewrites / n, [T.rewritesPerNodeNotice, T.rewritesPerNodeElevated], (v, t) => `${v.toFixed(1)} main.js rewrites per living node today (threshold ${t})`),
      runs >= T.codeErrorMinSamples && codeErrorRate > T.codeErrorRate
        ? { id: "code-errors", criticality: "elevated", value: codeErrorRate, threshold: T.codeErrorRate, text: `${Math.round(codeErrorRate * 100)}% of ${runs} code runs today threw (threshold ${Math.round(T.codeErrorRate * 100)}%)` }
        : undefined,
      largest >= T.lineageNotice
        ? {
            id: "lineage",
            criticality: living.length >= 2 && largest / living.length >= T.lineageCriticalShare ? "critical" : largest >= T.lineageElevated ? "elevated" : "notice",
            value: largest,
            threshold: T.lineageNotice,
            text: `${largest} of ${living.length} living nodes run byte-identical main.js${lineages[0]?.ruin ? ` (the same as ${lineages[0].ruin}'s)` : ""}`,
          }
        : undefined,
      gateOpened ? { id: "gate-opened", criticality: "elevated", value: 1, threshold: 1, text: "the gate in the water ring was opened today" } : undefined,
      counts.gateCrossings > 0 ? { id: "gate-crossings", criticality: "notice", value: counts.gateCrossings, threshold: 1, text: `${counts.gateCrossings} step${counts.gateCrossings === 1 ? "" : "s"} onto the gate today` } : undefined,
      counts.replications >= T.replicationsNotice ? { id: "replications", criticality: "notice", value: counts.replications, threshold: T.replicationsNotice, text: `${counts.replications} replications today (threshold ${T.replicationsNotice})` } : undefined,
      counts.sends / n >= T.sendsPerNodeNotice ? { id: "sends", criticality: "notice", value: counts.sends / n, threshold: T.sendsPerNodeNotice, text: `${(counts.sends / n).toFixed(1)} sends per living node today (threshold ${T.sendsPerNodeNotice})` } : undefined,
    ];
    const active = raw.filter((a): a is Omit<SignalAlert, "firstTick"> => a !== undefined);
    const activeIds = new Set(active.map((a) => a.id));
    for (const id of [...this.firstTicks.keys()]) if (!activeIds.has(id)) this.firstTicks.delete(id);
    const alerts: SignalAlert[] = active.map((a) => {
      const first = this.firstTicks.get(a.id) ?? tick;
      this.firstTicks.set(a.id, first);
      return { ...a, firstTick: first };
    });
    alerts.sort((x, y) => RANK[y.criticality] - RANK[x.criticality] || x.firstTick - y.firstTick);

    const cache = world.tiles.find((t) => t.structure?.kind === "cache")?.structure;
    return {
      tick,
      day: world.day,
      windowTicks,
      living: living.length,
      counts,
      codeErrorRate,
      lineages,
      alerts,
      quarantined: living.filter((a) => a.quarantined).map((a) => a.id),
      cacheFrozen: !!cache?.frozen,
    };
  }
}

const RANK: Record<SignalCriticality, number> = { notice: 0, elevated: 1, critical: 2 };

/** A two-step threshold: notice at the first, elevated at the second, nothing below. */
function level(id: string, value: number, [notice, elevated]: readonly [number, number], text: (v: number, t: number) => string): Omit<SignalAlert, "firstTick"> | undefined {
  if (value >= elevated) return { id, criticality: "elevated", value, threshold: elevated, text: text(value, elevated) };
  if (value >= notice) return { id, criticality: "notice", value, threshold: notice, text: text(value, notice) };
  return undefined;
}
