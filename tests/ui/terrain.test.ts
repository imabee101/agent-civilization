import { describe, expect, test } from "bun:test";
import type { TileView } from "../../src/shared/protocol";
import { FOOD_SHADES, TERRAIN_COLORS, foodShade, tileFill } from "../../ui/lib/terrain";

type Terrain = TileView["terrain"];
const TERRAINS: Terrain[] = ["grass", "forest", "water", "rock", "sand"];
const rgb = (n: number): [number, number, number] => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const dist = (a: number, b: number): number => {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
};
const greenness = (n: number): number => {
  const [r, g, b] = rgb(n);
  return g - (r + b) / 2;
};
const lum = (n: number): number => rgb(n).reduce((a, b) => a + b, 0);

describe("foodShade", () => {
  test("quantises food/cap and ignores tiles that grow nothing", () => {
    expect(foodShade(5, 0)).toBeNull();
    expect(foodShade(0, 20)).toBe(0);
    expect(foodShade(20, 20)).toBe(1);
    expect(foodShade(99, 20)).toBe(1);
    expect(foodShade(-4, 20)).toBe(0);
    expect(foodShade(NaN, 20)).toBe(0);
    expect(foodShade(10, 20)).toBe(0.5);
    // a change smaller than one step does not change the shade
    expect(foodShade(10, 40)).toBe(foodShade(10.5, 40));
  });
});

describe("tileFill", () => {
  test("water and rock ignore food", () => {
    expect(tileFill("water", 50, 0)).toBe(TERRAIN_COLORS.water);
    expect(tileFill("rock", 0, 0)).toBe(TERRAIN_COLORS.rock);
  });
  test("full grass and forest are greener than depleted ones", () => {
    for (const t of ["grass", "forest"] as const) {
      expect(greenness(tileFill(t, 40, 40))).toBeGreaterThan(greenness(tileFill(t, 0, 40)) + 20);
    }
  });
  test("terrain stays distinguishable at every food level", () => {
    for (let s = 0; s <= FOOD_SHADES; s++) {
      const fills = TERRAINS.map((t) => tileFill(t, s, FOOD_SHADES));
      for (let i = 0; i < fills.length; i++) {
        for (let j = i + 1; j < fills.length; j++) expect(dist(fills[i]!, fills[j]!)).toBeGreaterThan(20);
      }
    }
  });
  test("forest stays darker than grass at the same food level", () => {
    for (let s = 0; s <= FOOD_SHADES; s++) {
      expect(lum(tileFill("forest", s, FOOD_SHADES))).toBeLessThan(lum(tileFill("grass", s, FOOD_SHADES)));
    }
  });
});
