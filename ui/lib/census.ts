/**
 * Population facts for the header, derived from each node's own birth and
 * death ticks. Pure; no DOM. Ancient ruins (dead at tick 0) never count.
 */
import type { AgentView } from "../../src/shared/protocol";

type Life = Pick<AgentView, "alive" | "bornTick" | "diedTick">;

export interface Census {
  alive: number;
  /** Nodes that came into the world after the founders: children, newcomers, spawns. */
  born: number;
  /** Nodes that died after the world began. */
  died: number;
}

export function census(agents: readonly Life[]): Census {
  let alive = 0, born = 0, died = 0;
  for (const a of agents) {
    if (a.alive) alive++;
    else if ((a.diedTick ?? 0) > 0) died++;
    if (a.bornTick > 0) born++;
  }
  return { alive, born, died };
}

/** Living population sampled at `points` evenly spaced ticks from 0 to `now`, oldest first. */
export function populationSeries(agents: readonly Life[], now: number, points = 48): number[] {
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = points === 1 ? now : Math.round((now * i) / (points - 1));
    let n = 0;
    for (const a of agents) if (a.bornTick <= t && (a.alive || (a.diedTick ?? 0) > t)) n++;
    out.push(n);
  }
  return out;
}

/** SVG polyline points for a sparkline of `values` in a w×h box (y grows downward). */
export function sparkPoints(values: readonly number[], w: number, h: number): string {
  if (values.length === 0) return "";
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(" ");
}
