/** Axial hex coordinates (pointy-top). */
export interface Hex {
  q: number;
  r: number;
}

/** Six neighbour directions, index 0..5, going clockwise from east. */
export const DIRECTIONS: readonly Hex[] = [
  { q: 1, r: 0 }, // 0 east
  { q: 1, r: -1 }, // 1 north-east
  { q: 0, r: -1 }, // 2 north-west
  { q: -1, r: 0 }, // 3 west
  { q: -1, r: 1 }, // 4 south-west
  { q: 0, r: 1 }, // 5 south-east
];

export const DIRECTION_NAMES = ["e", "ne", "nw", "w", "sw", "se"] as const;
export type DirectionName = (typeof DIRECTION_NAMES)[number];

/** Accepts 0..5 or a compass name; returns the direction index or null. */
export function parseDirection(d: unknown): number | null {
  if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d < 6) return d;
  if (typeof d === "string") {
    const i = (DIRECTION_NAMES as readonly string[]).indexOf(d.toLowerCase());
    if (i >= 0) return i;
    const n = Number(d);
    if (Number.isInteger(n) && n >= 0 && n < 6) return n;
  }
  return null;
}

export function hexKey(h: Hex): string {
  return `${h.q},${h.r}`;
}

export function hexEquals(a: Hex, b: Hex): boolean {
  return a.q === b.q && a.r === b.r;
}

export function hexAdd(a: Hex, b: Hex): Hex {
  return { q: a.q + b.q, r: a.r + b.r };
}

export function hexNeighbor(h: Hex, dir: number): Hex {
  const d = DIRECTIONS[((dir % 6) + 6) % 6]!;
  return hexAdd(h, d);
}

export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** All hexes within `radius` of center (inclusive), including the center. */
export function hexesWithin(center: Hex, radius: number): Hex[] {
  const out: Hex[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const lo = Math.max(-radius, -dq - radius);
    const hi = Math.min(radius, -dq + radius);
    for (let dr = lo; dr <= hi; dr++) out.push({ q: center.q + dq, r: center.r + dr });
  }
  return out;
}

/** Direction index (0..5) that brings `from` closest to `to`; null if already there. */
export function directionToward(from: Hex, to: Hex): number | null {
  if (hexEquals(from, to)) return null;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 6; i++) {
    const d = hexDistance(hexNeighbor(from, i), to);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Is the hex inside a hexagonal map of the given radius centered at origin? */
export function inMap(h: Hex, mapRadius: number): boolean {
  return hexDistance(h, { q: 0, r: 0 }) <= mapRadius;
}
