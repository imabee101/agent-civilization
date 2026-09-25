import { describe, expect, test } from "bun:test";
import { Rng } from "../../src/world/rng";

describe("Rng", () => {
  test("deterministic for a seed", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  test("different seeds differ", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  test("values in [0,1) and int in range", () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const n = r.int(6);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(6);
    }
  });

  test("state round-trips", () => {
    const r = new Rng(9);
    r.next();
    const s = r.getState();
    const x = r.next();
    r.setState(s);
    expect(r.next()).toBe(x);
  });

  test("shuffle keeps elements", () => {
    const r = new Rng(3);
    const arr = r.shuffle([1, 2, 3, 4, 5]);
    expect([...arr].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test("pick throws on empty", () => {
    expect(() => new Rng(1).pick([])).toThrow();
  });
});
