import { describe, expect, test } from "bun:test";
import type { WorldEvent } from "../../src/shared/protocol";
import { FIRSTS, layoutTimeline, timelineFromEvents } from "../../ui/lib/timeline";
import { TIMELINE_FIRSTS } from "../../src/engine/history";

const ev = (id: number, kind: WorldEvent["kind"], tick: number, day = Math.floor(tick / 100) + 1): WorldEvent => ({ id, tick, day, kind, importance: 0, text: `${kind} ${id}` });

describe("timeline helpers", () => {
  test("the client and server mark the same firsts in the same order", () => {
    expect(FIRSTS.map((f) => [f.key, f.kind, f.label])).toEqual(TIMELINE_FIRSTS.map((f) => [f.key, f.kind, f.label]));
  });

  test("timelineFromEvents finds the first of each marked kind and counts per day", () => {
    const t = timelineFromEvents([ev(3, "cached", 30), ev(1, "spawned", 0), ev(2, "cached", 10), ev(4, "died", 150)]);
    expect(t.source).toBe("live");
    expect(t.firsts.map((f) => [f.key, f.event.id])).toEqual([
      ["cached", 2],
      ["died", 4],
    ]);
    expect(t.days).toEqual([
      { day: 1, total: 3, byKind: { spawned: 1, cached: 2 } },
      { day: 2, total: 1, byKind: { died: 1 } },
    ]);
    expect([t.firstTick, t.lastTick]).toEqual([0, 150]);
    expect(timelineFromEvents([])).toEqual({ firsts: [], days: [], firstTick: 0, lastTick: 0, source: "live" });
  });

  test("layout places day bars by tick span and stacks markers that would collide", () => {
    const t = timelineFromEvents([ev(1, "spawned", 0), ev(2, "cached", 10), ev(3, "spoke", 12), ev(4, "sent-message", 14), ev(5, "died", 150)]);
    const lay = layoutTimeline(t, 100);
    expect([lay.firstTick, lay.lastTick]).toEqual([0, 200]);
    expect(lay.bars.map((b) => [b.day, b.x, b.w, b.h, b.total])).toEqual([
      [1, 0, 0.5, 1, 4],
      [2, 0.5, 0.5, 0.25, 1],
    ]);
    const rows = Object.fromEntries(lay.markers.map((m) => [m.key, m.row]));
    expect(rows["cached"]).toBe(0);
    expect(rows["spoke"]).toBe(1);
    expect(rows["sent-message"]).toBe(2);
    expect(rows["died"]).toBe(0); // far enough along to reuse the first row
    expect(lay.markers.find((m) => m.key === "died")!.x).toBe(0.75);
  });
});
