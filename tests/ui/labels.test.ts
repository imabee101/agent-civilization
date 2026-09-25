import { describe, expect, test } from "bun:test";
import { LABEL_PRIORITY, visibleLabels, type LabelBox } from "../../ui/lib/labels";

const box = (id: string, x: number, y: number, priority: number = LABEL_PRIORITY.alive): LabelBox => ({ id, x, y, w: 40, h: 12, priority });

describe("visibleLabels", () => {
  test("labels that do not touch all show", () => {
    expect(visibleLabels([box("a", 0, 0), box("b", 100, 0), box("c", 0, 50)])).toEqual(new Set(["a", "b", "c"]));
  });
  test("of two overlapping labels only one shows, the one nearer the viewer", () => {
    expect(visibleLabels([box("a", 0, 0), box("b", 20, 4)])).toEqual(new Set(["b"]));
  });
  test("selected and thinking labels always show and win collisions", () => {
    const shown = visibleLabels([box("sel", 0, 0, LABEL_PRIORITY.selected), box("think", 10, 2, LABEL_PRIORITY.thinking), box("x", 20, 8)]);
    expect(shown).toEqual(new Set(["sel", "think"]));
  });
  test("living beats dead", () => {
    expect(visibleLabels([box("dead", 0, 10, LABEL_PRIORITY.dead), box("live", 5, 0)])).toEqual(new Set(["live"]));
  });
  test("padding separates labels that merely touch", () => {
    expect(visibleLabels([box("a", 0, 0), box("b", 41, 0)]).size).toBe(2);
    expect(visibleLabels([box("a", 0, 0), box("b", 41, 0)], 2).size).toBe(1);
  });
  test("stable for equal priority and position", () => {
    expect(visibleLabels([box("b", 0, 0), box("a", 0, 0)])).toEqual(new Set(["a"]));
    expect(visibleLabels([])).toEqual(new Set());
  });
});
