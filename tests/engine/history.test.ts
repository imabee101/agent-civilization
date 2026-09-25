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

  test("tick ranges come oldest first; the timeline marks firsts and counts per day", () => {
    const h = new HistoryStore();
    stores.push(h);
    h.recordEvents([
      ev(1, { kind: "spawned", day: 1, tick: 0 }),
      ev(2, { kind: "cached", day: 1, tick: 5, quote: "hello" }),
      ev(3, { kind: "cached", day: 1, tick: 6 }),
      ev(4, { kind: "spoke", day: 2, tick: 250 }),
      ev(5, { kind: "died", day: 2, tick: 260, importance: 3 }),
    ]);
    expect(h.events({ fromTick: 5, toTick: 250 }).map((e) => e.id)).toEqual([2, 3, 4]);
    expect(h.events({ fromTick: 251 }).map((e) => e.id)).toEqual([5]);
    const t = h.timeline();
    expect(t.source).toBe("history");
    expect(t.firsts.map((f) => [f.key, f.event.id])).toEqual([
      ["cached", 2],
      ["spoke", 4],
      ["died", 5],
    ]);
    expect(t.firsts[0]!.label).toBe("first Cache entry");
    expect(t.firsts[0]!.event.quote).toBe("hello");
    expect(t.days).toEqual([
      { day: 1, total: 3, byKind: { spawned: 1, cached: 2 } },
      { day: 2, total: 2, byKind: { spoke: 1, died: 1 } },
    ]);
    expect(t.firstTick).toBe(0);
    expect(t.lastTick).toBe(260);
    expect(new HistoryStore().timeline()).toEqual({ firsts: [], days: [], firstTick: 0, lastTick: 0, source: "history" });
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

  test("the system prompt is stored once per distinct text and read back whole; old rows keep their own copy", async () => {
    const h = new HistoryStore();
    stores.push(h);
    const long = "S".repeat(5000);
    h.recordDecision(dec(1, { prompt: { system: long, user: "U1" } }));
    h.recordDecision(dec(2, { prompt: { system: long, user: "U2" } }));
    h.recordDecision(dec(3, { prompt: { system: "other", user: "U3" } }));
    expect((h.db.query("SELECT COUNT(*) AS n FROM prompts").get() as { n: number }).n).toBe(2);
    expect((h.db.query("SELECT SUM(LENGTH(system_prompt)) AS n FROM decisions").get() as { n: number }).n).toBe(0);
    expect(h.decisions().map((d) => d.prompt.system.length)).toEqual([5000, 5000, 5]);
    // A file written before the prompts table existed: system_prompt holds the text, no system_hash column.
    const path = `${import.meta.dir}/../../scratch/history-old-${Date.now()}.sqlite`;
    const { Database } = await import("bun:sqlite");
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE decisions (id INTEGER PRIMARY KEY, tick INTEGER NOT NULL, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, backend TEXT NOT NULL, model TEXT NOT NULL, system_prompt TEXT NOT NULL, user_prompt TEXT NOT NULL, output TEXT NOT NULL, code TEXT, result TEXT, error TEXT, latency_ms INTEGER NOT NULL, tokens INTEGER, tokens_per_sec REAL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL);
      INSERT INTO decisions VALUES (1, 1, 'n0', 'A', 'b', 'm', 'OLD SYSTEM', 'U', 'out', NULL, NULL, NULL, 5, NULL, NULL, 1, 2);`);
    old.close();
    const reopened = new HistoryStore(path);
    stores.push(reopened);
    expect(reopened.decisions()[0]!.prompt.system).toBe("OLD SYSTEM");
    reopened.recordDecision(dec(2, { prompt: { system: "NEW", user: "U" } }));
    expect(reopened.decisions().map((d) => d.prompt.system)).toEqual(["OLD SYSTEM", "NEW"]);
    const { unlink } = await import("node:fs/promises");
    for (const suffix of ["", "-wal", "-shm"]) await unlink(path + suffix).catch(() => {});
  });

  test("backend timings are kept as columns and read back as timings", () => {
    const h = new HistoryStore();
    stores.push(h);
    h.recordDecision(dec(1, { timings: { promptTokens: 2000, cachedTokens: 1300, promptMs: 7000.5, outputTokens: 300, outputMs: 15_000 }, tokens: 300 }));
    h.recordDecision(dec(2));
    const [a, b] = h.decisions();
    expect(a!.timings).toEqual({ promptTokens: 2000, cachedTokens: 1300, promptMs: 7000.5, outputTokens: 300, outputMs: 15_000 });
    expect(b!.timings).toBeUndefined();
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

  test("prune drops old routine rows and keeps everything else", () => {
    const h = new HistoryStore(":memory:");
    stores.push(h);
    const ev = (id: number, tick: number, importance: 0 | 1 | 2 | 3) => ({ id, tick, day: 1, kind: "moved" as const, importance, text: "x" });
    h.recordEvents([ev(1, 10, 0), ev(2, 10, 1), ev(3, 900, 0), ev(4, 1000, 0)]);
    expect(h.prune(50)).toBe(2);
    expect(h.events({}).map((e) => e.id).sort()).toEqual([2, 4]);
  });
});
