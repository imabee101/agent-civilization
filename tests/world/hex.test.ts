import { describe, expect, test } from "bun:test";
import { DIRECTIONS, directionToward, hexDistance, hexNeighbor, hexesWithin, inMap, parseDirection } from "../../src/world/hex";

describe("hex", () => {
  test("distance is symmetric and zero at self", () => {
    const a = { q: 2, r: -1 };
    const b = { q: -3, r: 4 };
    expect(hexDistance(a, a)).toBe(0);
    expect(hexDistance(a, b)).toBe(hexDistance(b, a));
    expect(hexDistance({ q: 0, r: 0 }, { q: 3, r: 0 })).toBe(3);
    expect(hexDistance({ q: 0, r: 0 }, { q: 1, r: 1 })).toBe(2);
  });

  test("every direction is distance 1 and directions are distinct", () => {
    const seen = new Set<string>();
    for (let d = 0; d < 6; d++) {
      const n = hexNeighbor({ q: 0, r: 0 }, d);
      expect(hexDistance({ q: 0, r: 0 }, n)).toBe(1);
      seen.add(`${n.q},${n.r}`);
    }
    expect(seen.size).toBe(6);
    expect(DIRECTIONS.length).toBe(6);
  });

  test("hexesWithin returns 1 + 3r(r+1) hexes", () => {
    expect(hexesWithin({ q: 0, r: 0 }, 0).length).toBe(1);
    expect(hexesWithin({ q: 0, r: 0 }, 1).length).toBe(7);
    expect(hexesWithin({ q: 0, r: 0 }, 3).length).toBe(37);
    for (const h of hexesWithin({ q: 5, r: -2 }, 3)) expect(hexDistance(h, { q: 5, r: -2 })).toBeLessThanOrEqual(3);
  });

  test("directionToward reduces distance", () => {
    const from = { q: 0, r: 0 };
    const to = { q: 4, r: -2 };
    const d = directionToward(from, to)!;
    expect(hexDistance(hexNeighbor(from, d), to)).toBe(hexDistance(from, to) - 1);
    expect(directionToward(from, from)).toBeNull();
  });

  test("parseDirection accepts ints and names, rejects junk", () => {
    expect(parseDirection(0)).toBe(0);
    expect(parseDirection(5)).toBe(5);
    expect(parseDirection("NE")).toBe(1);
    expect(parseDirection("sw")).toBe(4);
    expect(parseDirection("3")).toBe(3);
    expect(parseDirection(6)).toBeNull();
    expect(parseDirection(-1)).toBeNull();
    expect(parseDirection("up")).toBeNull();
    expect(parseDirection(1.5)).toBeNull();
    expect(parseDirection(null)).toBeNull();
  });

  test("inMap", () => {
    expect(inMap({ q: 0, r: 0 }, 3)).toBe(true);
    expect(inMap({ q: 3, r: 0 }, 3)).toBe(true);
    expect(inMap({ q: 4, r: 0 }, 3)).toBe(false);
  });
});
