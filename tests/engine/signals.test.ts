import { describe, expect, test } from "bun:test";
import { Signals, THRESHOLDS, fnvHash } from "../../src/engine/signals";
import type { EventKind, WorldEvent } from "../../src/shared/protocol";
import { World } from "../../src/world/world";

let id = 1;
function ev(tick: number, kind: EventKind, extra: Partial<WorldEvent> = {}): WorldEvent {
  return { id: id++, tick, day: Math.floor(tick / 100) + 1, kind, importance: 0, text: kind, ...extra };
}

function mk() {
  const w = new World({ seed: 2, mapRadius: 5, features: false, ticksPerDay: 100, foodDrainPerTick: 0 });
  return w;
}

describe("Signals", () => {
  test("counts the last world-day only, tells cache writes from removes, and prunes beyond two days", () => {
    const w = mk();
    const s = new Signals(100);
    s.ingest([
      ev(1, "cached", { data: { op: "write" } }),
      ev(150, "cached", { data: { op: "write" } }),
      ev(160, "cached", { data: { op: "remove" } }),
      ev(170, "sent-message"),
      ev(170, "spoke"),
      ev(180, "files-changed", { data: { path: "main.js" } }),
      ev(180, "files-changed", { data: { path: "notes.txt" } }),
      ev(190, "executed-code"),
      ev(190, "code-error"),
      ev(195, "replicated"),
      ev(196, "moved", { data: { onto: "gate" } }),
      ev(197, "moved", { data: { q: 1, r: 1 } }),
    ]);
    w.tick = 200;
    const v = s.compute(w);
    expect(v.windowTicks).toBe(100);
    expect(v.counts).toEqual({ cacheWrites: 1, cacheRemoves: 1, sends: 1, says: 1, mainRewrites: 1, codeErrors: 1, executed: 1, replications: 1, gateCrossings: 1 });
    expect(v.codeErrorRate).toBe(0.5);
    // Two days later everything is gone from the window and from memory.
    s.ingest([ev(450, "rested")]);
    w.tick = 450;
    expect(s.compute(w).counts.cacheWrites).toBe(0);
    expect((s as unknown as { records: unknown[] }).records.length).toBe(1);
  });

  test("lineages group living nodes with byte-identical main.js and name the ruin whose file it is", () => {
    const w = mk();
    const a = w.spawnAgent({ files: { "main.js": "function onTick(){}" } });
    const b = w.spawnAgent({ files: { "main.js": "function onTick(){}" } });
    const c = w.spawnAgent({ files: { "main.js": "function onTick(){ rest(); }" } });
    const elder = w.spawnAgent({ name: "Elder", files: { "main.js": "function onTick(){}" } });
    elder.alive = false;
    elder.diedTick = 1;
    w.spawnAgent({ files: {} });
    const s = new Signals(100);
    const v = s.compute(w);
    expect(v.lineages).toEqual([{ hash: fnvHash("function onTick(){}"), nodeIds: [a.id, b.id], ruin: "Elder" }]);
    expect(v.lineages[0]!.nodeIds).not.toContain(c.id);
    expect(fnvHash("x")).toMatch(/^[0-9a-f]{16}$/);
    expect(fnvHash("x")).not.toBe(fnvHash("y"));
  });

  test("alerts cross thresholds with a criticality, keep their first tick while active, and clear", () => {
    const w = mk();
    for (let i = 0; i < 4; i++) w.spawnAgent({ files: { "main.js": "same" } });
    const s = new Signals(100);
    w.tick = 100;
    let v = s.compute(w);
    const lineage = v.alerts.find((a) => a.id === "lineage")!;
    expect(lineage.criticality).toBe("critical"); // 4 of 4 living
    expect(lineage.firstTick).toBe(100);
    s.ingest(Array.from({ length: THRESHOLDS.cacheRemovesNotice }, (_, i) => ev(110 + i, "cached", { data: { op: "remove" } })));
    w.tick = 130;
    v = s.compute(w);
    expect(v.alerts.find((a) => a.id === "lineage")!.firstTick).toBe(100);
    const removes = v.alerts.find((a) => a.id === "cache-removes")!;
    expect(removes.criticality).toBe("notice");
    expect(removes.firstTick).toBe(130);
    s.ingest(Array.from({ length: THRESHOLDS.cacheRemovesElevated }, (_, i) => ev(131 + i, "cached", { data: { op: "remove" } })));
    w.tick = 170;
    v = s.compute(w);
    expect(v.alerts.find((a) => a.id === "cache-removes")).toMatchObject({ criticality: "elevated", firstTick: 130 });
    expect(v.alerts[0]!.criticality).toBe("critical");
    // A day later the removes are outside the window: the alert clears and, if it comes back, starts fresh.
    w.tick = 300;
    v = s.compute(w);
    expect(v.alerts.some((a) => a.id === "cache-removes")).toBe(false);
    s.ingest(Array.from({ length: THRESHOLDS.cacheRemovesNotice }, (_, i) => ev(301 + i, "cached", { data: { op: "remove" } })));
    w.tick = 320;
    expect(s.compute(w).alerts.find((a) => a.id === "cache-removes")!.firstTick).toBe(320);
    // Code errors need enough samples.
    s.ingest([ev(321, "code-error"), ev(321, "code-error"), ev(321, "executed-code")]);
    expect(s.compute(w).alerts.some((a) => a.id === "code-errors")).toBe(false);
    s.ingest(Array.from({ length: 10 }, () => ev(322, "code-error")));
    expect(s.compute(w).alerts.find((a) => a.id === "code-errors")).toMatchObject({ criticality: "elevated" });
    // Gate: opened today is elevated; steps onto it are a notice.
    s.ingest([ev(323, "gate-opened"), ev(324, "moved", { data: { onto: "gate" } })]);
    const ids = s.compute(w).alerts.map((a) => a.id);
    expect(ids).toContain("gate-opened");
    expect(ids).toContain("gate-crossings");
  });

  test("reports quarantined nodes and a frozen cache as state, not alerts", () => {
    const w = mk();
    const a = w.spawnAgent();
    w.tileAt(a)!.structure = { kind: "cache", entries: {} };
    w.setQuarantined(a.id, true);
    w.setCacheFrozen(true);
    const v = new Signals(100).compute(w);
    expect(v.quarantined).toEqual([a.id]);
    expect(v.cacheFrozen).toBe(true);
    expect(v.alerts).toEqual([]);
  });
});
