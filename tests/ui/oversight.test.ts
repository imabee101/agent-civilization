import { describe, expect, test } from "bun:test";
import type { AgentView, SignalsView } from "../../src/shared/protocol";
import { alertsAtOrAbove, dropDead, initialWatch, isWatched, lineageRows, newAlertIds, noteThinking, setLimit, signalTiles, sortAlerts, unseenTotal, unwatch } from "../../ui/lib/oversight";

const view: SignalsView = {
  tick: 500,
  day: 3,
  windowTicks: 240,
  living: 4,
  counts: { cacheWrites: 8, cacheRemoves: 2, sends: 20, says: 5, mainRewrites: 3, codeErrors: 2, executed: 6, replications: 1, gateCrossings: 0 },
  codeErrorRate: 0.25,
  lineages: [{ hash: "abcdef0123456789", nodeIds: ["n1", "n2", "zz"], ruin: "Elder" }],
  alerts: [
    { id: "cache-writes", criticality: "notice", text: "writes", value: 2, threshold: 1, firstTick: 400 },
    { id: "lineage", criticality: "critical", text: "lineage", value: 3, threshold: 3, firstTick: 300 },
    { id: "gate-opened", criticality: "elevated", text: "gate", value: 1, threshold: 1, firstTick: 450 },
  ],
  quarantined: ["n2"],
  cacheFrozen: false,
};
const agent = (id: string, name: string): AgentView => ({ id, name, color: "#fff", q: 0, r: 0, alive: true, bornTick: 0, food: 1, energy: 1, health: 1, inventory: { food: 0, wood: 0, stone: 0, items: [] }, profile: {}, thinking: false, fileCount: 0, fsBytes: 0, turns: 0 });

describe("oversight helpers", () => {
  test("tiles carry the counts, per-node rates and mark alerting values hot", () => {
    const tiles = signalTiles(view);
    const byLabel = Object.fromEntries(tiles.map((t) => [t[0], t]));
    expect(byLabel["cache writes"]).toEqual(["cache writes", "8", "2.0 per node", true]);
    expect(byLabel["cache removes"]![3]).toBeFalsy();
    expect(byLabel["code errors"]![1]).toBe("25%");
    expect(byLabel["lineages"]).toEqual(["lineages", "1", "largest: 3 nodes", true]);
    expect(byLabel["quarantined"]).toEqual(["quarantined", "1", "cache open", true]);
    expect(byLabel["gate steps"]![3]).toBe(true);
  });

  test("alerts sort by severity then age; the floor hides the rest; new ones are those not seen before", () => {
    expect(sortAlerts(view.alerts).map((a) => a.id)).toEqual(["lineage", "gate-opened", "cache-writes"]);
    expect(alertsAtOrAbove(view.alerts, "elevated").map((a) => a.id)).toEqual(["lineage", "gate-opened"]);
    expect(alertsAtOrAbove(view.alerts, "critical").map((a) => a.id)).toEqual(["lineage"]);
    expect(newAlertIds(undefined, view.alerts, "elevated")).toEqual(["lineage", "gate-opened"]);
    expect(newAlertIds(view.alerts.slice(0, 2), view.alerts, "elevated")).toEqual(["gate-opened"]);
    expect(newAlertIds(view.alerts, view.alerts, "notice")).toEqual([]);
  });

  test("lineage rows use literal names and fall back to ids", () => {
    expect(lineageRows(view, [agent("n1", "Ash"), agent("n2", "Bo")])).toEqual([{ hash: "abcdef01", names: ["Ash", "Bo", "zz"], ruin: "Elder" }]);
  });

  test("watch budget: first come keeps the slot, the rest go unseen and are counted when they finish", () => {
    const w = initialWatch(2);
    expect(noteThinking(w, "a", false)).toBe(true);
    expect(noteThinking(w, "b", false)).toBe(true);
    expect(noteThinking(w, "c", false)).toBe(false);
    expect(noteThinking(w, "c", true)).toBe(false);
    expect(noteThinking(w, "a", true)).toBe(true);
    expect(w.watched).toEqual(["a", "b"]);
    expect(w.unseen).toEqual({ c: 1 });
    expect(unseenTotal(w)).toBe(1);
    expect(isWatched(w, "c")).toBe(false);
    unwatch(w, "a");
    expect(noteThinking(w, "c", false)).toBe(true);
    expect(w.watched).toEqual(["b", "c"]);
    dropDead(w, new Set(["c"]));
    expect(w.watched).toEqual(["c"]);
    setLimit(w, "unlimited");
    expect(isWatched(w, "zzz")).toBe(true);
    expect(noteThinking(w, "zzz", true)).toBe(true);
    setLimit(w, 3);
    noteThinking(w, "d", false);
    noteThinking(w, "e", false);
    noteThinking(w, "f", false);
    setLimit(w, 3);
    expect(w.watched.length).toBe(3);
    setLimit(w, 6);
    expect(w.limit).toBe(6);
  });
});
