import { describe, expect, test } from "bun:test";
import { census, populationSeries, sparkPoints } from "../../ui/lib/census";

const ancient = { alive: false, bornTick: 0, diedTick: 0 };
const founder = { alive: true, bornTick: 0 };
const deadFounder = { alive: false, bornTick: 0, diedTick: 50 };
const child = { alive: true, bornTick: 60 };

describe("census", () => {
  test("counts living, later births and later deaths; ancient ruins never count", () => {
    expect(census([ancient, founder, deadFounder, child])).toEqual({ alive: 2, born: 1, died: 1 });
  });

  test("population over time follows each node's birth and death ticks", () => {
    expect(populationSeries([ancient, founder, deadFounder, child], 100, 3)).toEqual([2, 1, 2]);
  });

  test("sparkline points span the box, highest value at the top", () => {
    expect(sparkPoints([0, 2], 10, 10)).toBe("0.0,9.0 10.0,1.0");
    expect(sparkPoints([], 10, 10)).toBe("");
  });
});
