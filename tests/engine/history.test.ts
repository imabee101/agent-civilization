import { afterEach, describe, expect, test } from "bun:test";
import { HistoryStore } from "../../src/engine/history";
import { Engine } from "../../src/engine/engine";
import type { DecisionRecord, WorldEvent } from "../../src/shared/protocol";
import { ScriptedBrain, js } from "./helpers";

const ev = (id: number, over: Partial<WorldEvent> = {}): WorldEvent => ({ id, tick: id * 2, day: 1, kind: "moved", importance: 0, text: `e${id}`, ...over });
const dec = (id: number, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id,
  tick: id,
  agentId: "n0",
  agentName: "A",
  backend: "scripted",
  model: "m",
  prompt: { system: "S", user: "U" },
  output: "```js\nrest()\n```",
  latencyMs: 5,
  startedAt: 1,
  finishedAt: 2,
  ...over,
});

const stores: HistoryStore[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const e of engines.splice(0)) await e.shutdown();
});

describe("HistoryStore", () => {
  test("records and queries events with filters and paging", () => {
    const h = new HistoryStore();
    stores.push(h);
    h.recordEvents([ev(1), ev(2, { kind: "spoke", importance: 1, agentId: "n1", quote: "hi", data: { x: 1 } }), ev(3, { kind: "died", importance: 3, agentId: "n2", targetId: "n1" })]);
    expect(h.events().map((e) => e.id)).toEqual([1, 2, 3]);
    expect(h.events({ kind: "spoke" })[0]).toMatchObject({ id: 2, quote: "hi", data: { x: 1 }, agentId: "n1" });
    expect(h.events({ agentId: "n1" }).map((e) => e.id)).toEqual([2, 3]);
    expect(h.events({ minImportance: 1 }).map((e) => e.id)).toEqual([2, 3]);
    expect(h.events({ before: 3, limit: 1 }).map((e) => e.id)).toEqual([2]);
    // idempotent on replay (INSERT OR REPLACE)
    h.recordEvents([ev(2, { text: "changed" })]);
    expect(h.events({ kind: "spoke" }).length).toBe(0);
    expect(h.events().length).toBe(3);
    expect(h.events().find((e) => e.id === 2)!.text).toBe("changed");
  });

  test("records and queries decisions", () => {
    const h = new HistoryStore();
    stores.push(h);
    h.recordDecision(dec(1));
    h.recordDecision(dec(2, { agentId: "n1", error: "boom", tokens: 9, tokensPerSec: 3.5, code: "rest()", result: "undefined" }));
    expect(h.decisions().map((d) => d.id)).toEqual([1, 2]);
    expect(h.decisions({ agentId: "n1" })[0]).toMatchObject({ id: 2, error: "boom", tokens: 9, tokensPerSec: 3.5, code: "rest()", prompt: { system: "S", user: "U" } });
    expect(h.decisions({ before: 2 }).map((d) => d.id)).toEqual([1]);
    expect(h.decisions()[0]!.error).toBeUndefined();
  });

  test("stats and clear", () => {
    const h = new HistoryStore();
    stores.push(h);
    h.recordEvents([ev(1), ev(2, { kind: "spoke" })]);
    h.recordDecision(dec(1));
    const s = h.stats();
    expect(s).toMatchObject({ events: 2, decisions: 1, firstTick: 2, lastTick: 4, byKind: { moved: 1, spoke: 1 }, path: ":memory:" });
    h.clear();
    expect(h.stats().events).toBe(0);
    expect(h.stats().decisions).toBe(0);
  });

  test("persists to a file across reopen", async () => {
    const path = `${import.meta.dir}/../../scratch/hist-${Date.now()}.sqlite`;
    const h = new HistoryStore(path);
    h.recordEvents([ev(1)]);
    h.close();
    const h2 = new HistoryStore(path);
    stores.push(h2);
    expect(h2.events().length).toBe(1);
    h2.close();
    const { unlink } = await import("node:fs/promises");
    for (const suffix of ["", "-wal", "-shm"]) await unlink(path + suffix).catch(() => {});
  });

  test("the engine writes events and decisions through when a store is attached", async () => {
    const e = new Engine(new ScriptedBrain([js("rest()")]), { world: { seed: 1, mapRadius: 5, features: false }, initialAgents: 1, healthEveryMs: 0, snapshotEveryTicks: 0 });
    await e.init();
    engines.push(e);
    const h = new HistoryStore();
    stores.push(h);
    e.history = h;
    const [a] = e.world.livingAgents();
    await e.runTurn(a!.id);
    await e.tick();
    expect(h.stats().decisions).toBe(1);
    expect(h.events({ kind: "executed-code" }).length).toBe(1);
    await e.reset(2);
    expect(h.stats().events).toBeGreaterThan(0); // reset clears, then records the new world's spawns
    expect(h.events({ kind: "executed-code" }).length).toBe(0);
  });
});
