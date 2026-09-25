import { describe, expect, test } from "bun:test";
import type { EventKind, WorldEvent } from "../../src/shared/protocol";
import { ARC_MS, MAX_EFFECTS, STALE_TICKS, arcControl, fadeAlpha, glyphFor, hungerFraction, hungerLevel, planEffects, quadPoint } from "../../ui/lib/effects";

let nextId = 0;
const ev = (kind: EventKind, agentId?: string, extra: Partial<WorldEvent> = {}): WorldEvent => ({
  id: ++nextId,
  tick: 10,
  day: 1,
  kind,
  importance: 1,
  agentId,
  text: "",
  ...extra,
});
const living = new Set(["a", "b", "c"]);

describe("glyphFor", () => {
  test("maps action kinds and ignores the rest", () => {
    for (const k of ["gathered", "ate", "rested", "built", "planted", "dropped", "replicated", "took-item"] as const) expect(glyphFor(k)).toBe(k);
    expect(glyphFor("dropped-item")).toBe("dropped");
    for (const k of ["moved", "executed-code", "profile-changed", "spoke", "died"] as const) expect(glyphFor(k)).toBeNull();
  });
});

describe("planEffects", () => {
  test("glyphs only for living known nodes, latest action per node wins", () => {
    const { glyphs } = planEffects([ev("ate", "a"), ev("rested", "a"), ev("built", "zz"), ev("moved", "b"), ev("gathered")], living, 10);
    expect(glyphs).toEqual([{ agentId: "a", glyph: "rested" }]);
  });
  test("arcs need a living sender and a living, different target", () => {
    const { arcs, glyphs } = planEffects(
      [
        ev("sent-message", "a", { targetId: "b" }),
        ev("sent-message", "a", { targetId: "dead" }),
        ev("sent-message", "a"),
        ev("sent-message", "c", { targetId: "c" }),
        ev("sent-message", "zz", { targetId: "a" }),
      ],
      living,
      10,
    );
    expect(arcs).toEqual([{ from: "a", to: "b" }]);
    expect(glyphs).toEqual([]);
  });
  test("stale events (history replay) are skipped", () => {
    expect(planEffects([ev("ate", "a", { tick: 10 - STALE_TICKS - 1 })], living, 10).glyphs).toEqual([]);
    expect(planEffects([ev("ate", "a", { tick: 10 - STALE_TICKS })], living, 10).glyphs.length).toBe(1);
    expect(planEffects([ev("ate", "a", { tick: 0 })], living, null).glyphs.length).toBe(1);
  });
  test("caps arcs and glyphs, keeping the newest", () => {
    const names = Array.from({ length: 50 }, (_, i) => `n${i}`);
    const many = new Set(names);
    const evs = names.flatMap((n, i) => [ev("ate", n), ev("sent-message", n, { targetId: `n${(i + 1) % 50}` })]);
    const { glyphs, arcs } = planEffects(evs, many, 10);
    expect(glyphs.length).toBe(MAX_EFFECTS);
    expect(arcs.length).toBe(MAX_EFFECTS);
    expect(glyphs.at(-1)!.agentId).toBe("n49");
    expect(arcs.at(-1)!.from).toBe("n49");
  });
});

describe("fadeAlpha", () => {
  test("holds, fades, then expires", () => {
    expect(fadeAlpha(0, ARC_MS)).toBe(1);
    expect(fadeAlpha(ARC_MS * 0.5, ARC_MS)).toBe(1);
    const mid = fadeAlpha(ARC_MS * 0.8, ARC_MS);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(fadeAlpha(ARC_MS, ARC_MS)).toBe(0);
    expect(fadeAlpha(-1, ARC_MS)).toBe(0);
    expect(fadeAlpha(NaN, ARC_MS)).toBe(0);
  });
});

describe("arc geometry", () => {
  test("curve starts and ends at the endpoints and bows sideways", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const c = arcControl(a, b);
    expect(quadPoint(a, c, b, 0)).toEqual(a);
    expect(quadPoint(a, c, b, 1)).toEqual(b);
    expect(Math.abs(c.y)).toBe(25);
    expect(Math.abs(arcControl(a, { x: 1000, y: 0 }).y)).toBe(60);
    expect(arcControl(a, a)).toEqual(a);
  });
});

describe("hunger", () => {
  test("levels follow the thresholds", () => {
    expect(hungerLevel(100)).toBe("fed");
    expect(hungerLevel(51)).toBe("fed");
    expect(hungerLevel(50)).toBe("low");
    expect(hungerLevel(20)).toBe("low");
    expect(hungerLevel(19)).toBe("critical");
    expect(hungerLevel(0)).toBe("starving");
    expect(hungerLevel(NaN)).toBe("starving");
  });
  test("fraction is clamped", () => {
    expect(hungerFraction(150)).toBe(1);
    expect(hungerFraction(-1)).toBe(0);
    expect(hungerFraction(25)).toBe(0.25);
  });
});
