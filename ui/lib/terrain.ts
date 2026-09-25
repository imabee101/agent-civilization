/**
 * Tile fill colour. Pure: food is shown as shading inside each terrain's own
 * colour band (drab when depleted, lush when full), so terrain stays readable.
 */
import type { TileView } from "../../src/shared/protocol";

type Terrain = TileView["terrain"];

/** Nominal terrain colours (minimap and tiles without food). */
export const TERRAIN_COLORS: Record<Terrain, number> = {
  grass: 0x3f7a4a,
  forest: 0x2b5a3a,
  water: 0x1f4f7a,
  rock: 0x59606e,
  sand: 0xa8925c,
};

export const TERRAIN_EDGE: Record<Terrain, number> = {
  grass: 0x2c5a36,
  forest: 0x1e4229,
  water: 0x173c5e,
  rock: 0x3f454f,
  sand: 0x7d6b42,
};

/** [depleted, full] fill for terrain that grows food. */
const FOOD_RANGE: Partial<Record<Terrain, [number, number]>> = {
  grass: [0x55623f, 0x3d8a4c],
  forest: [0x33432f, 0x22683a],
  sand: [0x9a8a64, 0xaa9858],
};

/** Shading steps: food changes smaller than one step do not change the fill. */
export const FOOD_SHADES = 8;

function mixRgb(a: number, b: number, t: number): number {
  const ch = (n: number, s: number) => (n >> s) & 255;
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

/** Food relative to cap, quantised to FOOD_SHADES steps; null when the tile grows no food. */
export function foodShade(food: number, foodCap: number): number | null {
  if (!(foodCap > 0)) return null;
  const ratio = Number.isFinite(food) ? Math.min(1, Math.max(0, food / foodCap)) : 0;
  return Math.round(ratio * FOOD_SHADES) / FOOD_SHADES;
}

export function tileFill(terrain: Terrain, food: number, foodCap: number): number {
  const range = FOOD_RANGE[terrain];
  const shade = foodShade(food, foodCap);
  if (!range || shade === null) return TERRAIN_COLORS[terrain] ?? TERRAIN_COLORS.grass;
  return mixRgb(range[0], range[1], shade);
}
