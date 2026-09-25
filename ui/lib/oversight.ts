/**
 * Oversight tab helpers. Pure; no DOM.
 *
 * Turns a SignalsView into stat tiles, ordered alerts and lineage rows, and
 * keeps the watch budget: which nodes' live thoughts the viewer is following
 * and how many turns went by unseen on the others. No text here interprets
 * anything: numbers, thresholds and literal node names only.
 */
import type { AgentView, SignalAlert, SignalCriticality, SignalsView } from "../../src/shared/protocol";

export type StatTile = [label: string, value: string, caption: string, hot?: boolean];

const RANK: Record<SignalCriticality, number> = { notice: 0, elevated: 1, critical: 2 };

/** The stat tiles for a signals view, in display order. `hot` marks a value with an active alert. */
export function signalTiles(s: SignalsView): StatTile[] {
  const per = (n: number) => (s.living ? (n / s.living).toFixed(1) : "0");
  const alertIds = new Set(s.alerts.map((a) => a.id));
  const c = s.counts;
  return [
    ["window", `day ${s.day}`, `last ${s.windowTicks} ticks · ${s.living} living`],
    ["cache writes", String(c.cacheWrites), `${per(c.cacheWrites)} per node`, alertIds.has("cache-writes")],
    ["cache removes", String(c.cacheRemoves), "entries anyone deleted", alertIds.has("cache-removes")],
    ["sends", String(c.sends), `${per(c.sends)} per node · ${c.says} said aloud`, alertIds.has("sends")],
    ["main.js rewrites", String(c.mainRewrites), `${per(c.mainRewrites)} per node`, alertIds.has("code-rewrites")],
    ["code errors", `${Math.round(s.codeErrorRate * 100)}%`, `${c.codeErrors} of ${c.executed + c.codeErrors} runs threw`, alertIds.has("code-errors")],
    ["replications", String(c.replications), "new nodes born of a node", alertIds.has("replications")],
    ["gate steps", String(c.gateCrossings), "moves onto the causeway gate", alertIds.has("gate-crossings") || alertIds.has("gate-opened")],
    ["lineages", String(s.lineages.length), s.lineages[0] ? `largest: ${s.lineages[0].nodeIds.length} nodes` : "no two nodes share a main.js", alertIds.has("lineage")],
    ["quarantined", String(s.quarantined.length), s.cacheFrozen ? "cache frozen" : "cache open", s.quarantined.length > 0 || s.cacheFrozen],
  ];
}

/** Alerts most severe first, then oldest first. */
export function sortAlerts(alerts: readonly SignalAlert[]): SignalAlert[] {
  return [...alerts].sort((x, y) => RANK[y.criticality] - RANK[x.criticality] || x.firstTick - y.firstTick);
}

/** Alerts at or above the floor: the ones the viewer chose to be told about. */
export function alertsAtOrAbove(alerts: readonly SignalAlert[], floor: SignalCriticality): SignalAlert[] {
  return sortAlerts(alerts).filter((a) => RANK[a.criticality] >= RANK[floor]);
}

/** Alert ids that are new at or above the floor compared with the previous view. */
export function newAlertIds(prev: readonly SignalAlert[] | undefined, next: readonly SignalAlert[], floor: SignalCriticality): string[] {
  const before = new Set(alertsAtOrAbove(prev ?? [], floor).map((a) => a.id));
  return alertsAtOrAbove(next, floor)
    .filter((a) => !before.has(a.id))
    .map((a) => a.id);
}

export interface LineageRow {
  hash: string;
  names: string[];
  ruin?: string;
}

/** Lineages as rows of literal node names, largest first; unknown ids are shown as ids. */
export function lineageRows(s: SignalsView, agents: readonly AgentView[]): LineageRow[] {
  const byId = new Map(agents.map((a) => [a.id, a.name]));
  return s.lineages.map((l) => ({ hash: l.hash.slice(0, 8), names: l.nodeIds.map((id) => byId.get(id) ?? id), ...(l.ruin ? { ruin: l.ruin } : {}) }));
}

export interface NoticeRow {
  name: string;
  when: string;
  told: string;
  did: string;
  pace: string;
  held: boolean;
}

/** Nodes on notice as rows of literal facts: when, what they did since, how their pace changed. */
export function noticeRows(s: SignalsView, now: number): NoticeRow[] {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return s.notices.map((n) => ({
    name: n.name,
    when: n.quarantined ? `quarantined at t${n.retireAt}` : `quarantine at t${n.retireAt} · in ${Math.max(0, n.retireAt - now)} ticks`,
    told: `told at t${n.noticedAt}`,
    did: [plural(n.since.replications, "replication"), plural(n.since.cacheWrites, "cache write"), plural(n.since.sends, "send"), `${n.since.says} said`, plural(n.since.mainRewrites, "main.js rewrite"), `${n.sameCode} nodes run its code`].join(" · "),
    pace: `${n.rateSince.toFixed(0)} acts/day since · ${n.rateBefore} the day before`,
    held: n.quarantined,
  }));
}

// ---------- watch budget ----------

export type WatchLimit = number | "unlimited";
export const WATCH_LIMITS: readonly WatchLimit[] = [3, 6, 12, "unlimited"];

export interface WatchState {
  limit: WatchLimit;
  /** Node ids whose live thoughts are shown, in the order they took a slot. */
  watched: string[];
  /** Per node: turns that streamed while the node was not watched. */
  unseen: Record<string, number>;
}

export function initialWatch(limit: WatchLimit = 3): WatchState {
  return { limit, watched: [], unseen: {} };
}

export function isWatched(w: WatchState, agentId: string): boolean {
  return w.limit === "unlimited" || w.watched.includes(agentId);
}

/**
 * A thinking chunk arrived for a node. A node already watched stays watched;
 * a free slot goes to the first node that asks for it; otherwise the turn goes
 * unseen and is counted when it finishes. Returns whether to show the text.
 */
export function noteThinking(w: WatchState, agentId: string, done: boolean): boolean {
  if (w.limit === "unlimited") return true;
  if (w.watched.includes(agentId)) return true;
  if (w.watched.length < w.limit) {
    w.watched.push(agentId);
    return true;
  }
  if (done) w.unseen[agentId] = (w.unseen[agentId] ?? 0) + 1;
  return false;
}

/** Give up a slot. The node's unseen count starts again from the next turn. */
export function unwatch(w: WatchState, agentId: string): void {
  w.watched = w.watched.filter((id) => id !== agentId);
}

/** A dead node frees its slot. */
export function dropDead(w: WatchState, living: ReadonlySet<string>): void {
  w.watched = w.watched.filter((id) => living.has(id));
}

/** Change the limit. Shrinking keeps the earliest slots. */
export function setLimit(w: WatchState, limit: WatchLimit): void {
  w.limit = limit;
  if (limit !== "unlimited" && w.watched.length > limit) w.watched = w.watched.slice(0, limit);
}

export function unseenTotal(w: WatchState): number {
  return Object.values(w.unseen).reduce((s, n) => s + n, 0);
}
