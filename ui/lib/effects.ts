/**
 * Transient map effects (action glyphs, message arcs, hunger rings). Pure:
 * decides what to show and how it animates; world.ts only draws it.
 */
import type { EventKind, WorldEvent } from "../../src/shared/protocol";

export type GlyphKind = "gathered" | "ate" | "rested" | "built" | "planted" | "dropped" | "replicated" | "took-item";

const GLYPH_OF: Partial<Record<EventKind, GlyphKind>> = {
  gathered: "gathered",
  ate: "ate",
  rested: "rested",
  built: "built",
  planted: "planted",
  dropped: "dropped",
  "dropped-item": "dropped",
  replicated: "replicated",
  "took-item": "took-item",
};

/** The glyph a node's own event shows, or null for kinds with no glyph. */
export function glyphFor(kind: EventKind): GlyphKind | null {
  return GLYPH_OF[kind] ?? null;
}

/** Wall-clock lifetimes, in ms. */
export const GLYPH_MS = 2600;
export const ARC_MS = 2000;
/** Most simultaneous glyphs / arcs on screen. */
export const MAX_EFFECTS = 32;
/** Events older than this many ticks (e.g. history replayed on connect) show nothing. */
export const STALE_TICKS = 3;

export interface GlyphRequest {
  agentId: string;
  glyph: GlyphKind;
}
export interface ArcRequest {
  from: string;
  to: string;
}

/**
 * Turn a batch of events into effects. Only living known nodes get effects; a
 * node keeps one glyph (its latest action); both lists are capped at MAX_EFFECTS.
 */
export function planEffects(
  events: readonly WorldEvent[],
  living: ReadonlySet<string>,
  currentTick: number | null,
): { glyphs: GlyphRequest[]; arcs: ArcRequest[] } {
  const glyphs = new Map<string, GlyphRequest>();
  const arcs: ArcRequest[] = [];
  for (const e of events) {
    if (currentTick !== null && currentTick - e.tick > STALE_TICKS) continue;
    if (!e.agentId || !living.has(e.agentId)) continue;
    if (e.kind === "sent-message") {
      if (e.targetId && e.targetId !== e.agentId && living.has(e.targetId)) arcs.push({ from: e.agentId, to: e.targetId });
      continue;
    }
    const glyph = glyphFor(e.kind);
    if (!glyph) continue;
    glyphs.delete(e.agentId); // re-insert so the latest action wins and orders last
    glyphs.set(e.agentId, { agentId: e.agentId, glyph });
  }
  return { glyphs: [...glyphs.values()].slice(-MAX_EFFECTS), arcs: arcs.slice(-MAX_EFFECTS) };
}

/** Opacity over an effect's life: full, then a linear fade over the last `fadeFrac`. 0 once expired. */
export function fadeAlpha(ageMs: number, lifeMs: number, fadeFrac = 0.4): number {
  if (!(ageMs >= 0) || ageMs >= lifeMs) return 0;
  const fadeStart = lifeMs * (1 - fadeFrac);
  return ageMs <= fadeStart ? 1 : 1 - (ageMs - fadeStart) / (lifeMs - fadeStart);
}

export interface Pt {
  x: number;
  y: number;
}

/** Control point of a message arc: bowed to one side by a quarter of the distance (capped). */
export function arcControl(a: Pt, b: Pt, maxBend = 60): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return { x: a.x, y: a.y };
  const bend = Math.min(maxBend, d * 0.25);
  return { x: (a.x + b.x) / 2 - (dy / d) * bend, y: (a.y + b.y) / 2 + (dx / d) * bend };
}

/** Point at t (0..1) on the quadratic curve a -> c -> b. */
export function quadPoint(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

export type HungerLevel = "fed" | "low" | "critical" | "starving";

/** food 0..100: >50 fed, 20..50 low, <20 critical, 0 starving. */
export function hungerLevel(food: number): HungerLevel {
  const f = Number.isFinite(food) ? food : 0;
  if (f <= 0) return "starving";
  if (f < 20) return "critical";
  if (f <= 50) return "low";
  return "fed";
}

export const HUNGER_COLOR: Record<HungerLevel, number> = {
  fed: 0x5fd08a,
  low: 0xffcf6b,
  critical: 0xff5c5c,
  starving: 0xff5c5c,
};

/** Fraction of the hunger ring to fill (0..1). */
export function hungerFraction(food: number): number {
  return Number.isFinite(food) ? Math.min(1, Math.max(0, food / 100)) : 0;
}
