/**
 * Post-mortem timeline helpers. Pure; no DOM.
 *
 * The "firsts": the first time each kind of thing happened in a world, laid
 * along a day axis with the volume of events per day underneath. Built from
 * the SQLite history on the server, or from the events a client holds when
 * there is no history. Only literal event text and quotes are shown; the
 * labels here name kinds of event, never what they meant.
 */
import type { TimelineView, WorldEvent } from "../../src/shared/protocol";

/** The kinds whose first occurrence the timeline marks, with the label the axis shows. Order is display order. */
export const FIRSTS: readonly { key: string; kind: WorldEvent["kind"]; label: string }[] = [
  { key: "cached", kind: "cached", label: "first Cache entry" },
  { key: "sent-message", kind: "sent-message", label: "first message sent" },
  { key: "spoke", kind: "spoke", label: "first word spoken" },
  { key: "ruin-read", kind: "ruin-read", label: "first ruin read" },
  { key: "files-changed", kind: "files-changed", label: "first file rewritten" },
  { key: "profile-changed", kind: "profile-changed", label: "first self-declaration" },
  { key: "replicated", kind: "replicated", label: "first replication" },
  { key: "riddle-answered", kind: "riddle-answered", label: "first riddle answered" },
  { key: "vault-opened", kind: "vault-opened", label: "vault opened" },
  { key: "gate-opened", kind: "gate-opened", label: "gate opened" },
  { key: "starving", kind: "starving", label: "first node starving" },
  { key: "died", kind: "died", label: "first death" },
  { key: "era-began", kind: "era-began", label: "a new era" },
  { key: "operator", kind: "operator", label: "first operator action" },
];

/** A timeline from events a client already holds (the live ring buffer). The server builds the same shape from SQLite. */
export function timelineFromEvents(events: readonly WorldEvent[]): TimelineView {
  const sorted = [...events].sort((a, b) => a.id - b.id);
  const firsts: TimelineView["firsts"] = [];
  for (const f of FIRSTS) {
    const e = sorted.find((x) => x.kind === f.kind);
    if (e) firsts.push({ key: f.key, label: f.label, event: e });
  }
  const byDay = new Map<number, { total: number; byKind: Record<string, number> }>();
  for (const e of sorted) {
    const d = byDay.get(e.day) ?? { total: 0, byKind: {} };
    d.total++;
    d.byKind[e.kind] = (d.byKind[e.kind] ?? 0) + 1;
    byDay.set(e.day, d);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, d]) => ({ day, ...d }));
  return { firsts, days, firstTick: sorted[0]?.tick ?? 0, lastTick: sorted.at(-1)?.tick ?? 0, source: "live" };
}

export interface TimelineLayout {
  /** Day bars: x, width, height as fractions of the axis (0..1). */
  bars: { day: number; x: number; w: number; h: number; total: number }[];
  /** Markers: x as a fraction of the axis, stacked into rows so labels do not overlap. */
  markers: { key: string; label: string; x: number; row: number; tick: number }[];
  firstTick: number;
  lastTick: number;
}

/** Lay firsts and day volumes along one axis. `slotFraction` is how close two markers may sit before the second drops a row. */
export function layoutTimeline(view: TimelineView, ticksPerDay: number, slotFraction = 0.08, maxRows = 4): TimelineLayout {
  const first = view.days.length ? (view.days[0]!.day - 1) * ticksPerDay : view.firstTick;
  const last = Math.max(view.lastTick, view.days.length ? view.days.at(-1)!.day * ticksPerDay : view.firstTick + 1);
  const span = Math.max(1, last - first);
  const maxTotal = Math.max(1, ...view.days.map((d) => d.total));
  const bars = view.days.map((d) => {
    const start = Math.max(first, (d.day - 1) * ticksPerDay);
    const end = Math.min(last, d.day * ticksPerDay);
    return { day: d.day, x: (start - first) / span, w: Math.max(0, end - start) / span, h: d.total / maxTotal, total: d.total };
  });
  const rowEnds: number[] = [];
  const markers = [...view.firsts]
    .sort((a, b) => a.event.tick - b.event.tick)
    .map((f) => {
      const x = (f.event.tick - first) / span;
      let row = rowEnds.findIndex((end) => x - end >= slotFraction);
      if (row === -1) row = rowEnds.length < maxRows ? rowEnds.length : rowEnds.indexOf(Math.min(...rowEnds));
      rowEnds[row] = x;
      return { key: f.key, label: f.label, x, row, tick: f.event.tick };
    });
  return { bars, markers, firstTick: first, lastTick: last };
}
