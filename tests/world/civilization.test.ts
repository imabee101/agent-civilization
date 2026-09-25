import { afterEach, describe, expect, test } from "bun:test";
import { SEASON_REGROWTH, World, WorldError } from "../../src/world/world";
import { hexDistance } from "../../src/world/hex";
import { Engine } from "../../src/engine/engine";
import { ScriptedBrain } from "../engine/helpers";

function mk(extra = {}) {
  return new World({ seed: 5, mapRadius: 6, features: false, foodDrainPerTick: 0, ...extra });
}

describe("replication", () => {
  test("a fed node can replicate: the child is adjacent, inherits files and profile, and records its parent", () => {
    const w = mk();
    const a = w.spawnAgent({ files: { "main.js": "function onTick(){}", "notes.txt": "x" } });
    w.setProfile(a.id, "group", "river");
    a.inventory.food = 50;
    a.energy = 100;
    w.drainEvents();
    w.intentReplicate(a.id, "Kid");
    w.step();
    const kids = w.livingAgents().filter((x) => x.parentId === a.id);
    expect(kids.length).toBe(1);
    const kid = kids[0]!;
    expect(kid.name).toBe("Kid");
    expect(hexDistance(kid, a)).toBe(1);
    expect(kid.files).toEqual(a.files);
    expect(kid.files).not.toBe(a.files);
    expect(kid.profile.group).toBe("river");
    expect(kid.inventory.food).toBe(10);
    expect(a.inventory.food).toBe(10);
    expect(a.energy).toBeLessThanOrEqual(100 - w.config.replicateEnergy);
    const ev = w.drainEvents().find((e) => e.kind === "replicated")!;
    expect(ev.agentId).toBe(a.id);
    expect(ev.targetId).toBe(kid.id);
    expect(w.agentView(kid).parentId).toBe(a.id);
    // The child is its own node: changing its files does not touch the parent.
    w.fsWrite(kid.id, "main.js", "// mine now");
    expect(a.files["main.js"]).toBe("function onTick(){}");
  });

  test("replication is refused without food, energy, space or under the population cap", () => {
    const w = mk({ maxPopulation: 2 });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    a.inventory.food = 5;
    expect(() => w.intentReplicate(a.id)).toThrow(/needs 40 food/);
    a.inventory.food = 60;
    a.energy = 10;
    expect(() => w.intentReplicate(a.id)).toThrow(/energy/);
    a.energy = 100;
    expect(() => w.intentReplicate(a.id, 42)).toThrow(/name must be a string/);
    w.intentReplicate(a.id);
    w.step();
    expect(w.livingAgents().length).toBe(2);
    a.inventory.food = 60;
    a.energy = 100;
    expect(() => w.intentReplicate(a.id)).toThrow(/at most 2 living/);
  });

  test("replication needs a free hex: surrounded nodes cannot replicate", () => {
    const w = mk({ maxPopulation: 20 });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    for (let d = 0; d < 6; d++) {
      const t = w.tiles.find((x) => hexDistance(x, a) === 1 && (x.q - a.q === [1, 1, 0, -1, -1, 0][d] && x.r - a.r === [0, -1, -1, 0, 1, 1][d]))!;
      if (t.terrain === "water") t.terrain = "grass";
      w.spawnAgent({ at: t });
    }
    a.inventory.food = 60;
    a.energy = 100;
    expect(() => w.intentReplicate(a.id)).toThrow(/free passable hex/);
  });

  test("conditions are re-checked when the intent resolves", () => {
    const w = mk();
    const a = w.spawnAgent();
    a.inventory.food = 60;
    a.energy = 100;
    w.intentReplicate(a.id);
    a.inventory.food = 0; // ate it all before the tick resolved
    w.step();
    expect(w.livingAgents().length).toBe(1);
    expect(a.log.at(-1)).toContain("conditions no longer met");
  });

  test("the engine gives a replicated child its own sandbox running the inherited script", async () => {
    const e = new Engine(new ScriptedBrain(), { world: { seed: 5, mapRadius: 6, features: false, foodDrainPerTick: 0 }, initialAgents: 1, healthEveryMs: 0, snapshotEveryTicks: 0 });
    await e.init();
    try {
      const [a] = e.world.livingAgents();
      e.world.fsWrite(a!.id, "main.js", "var n = 0; function onTick(){ n++; me.set('ticks', String(n)); if (observe().me.inventory.food >= 40 && n === 2) replicate(); }");
      a!.inventory.food = 60;
      a!.energy = 100;
      for (let i = 0; i < 4; i++) await e.tick();
      const kids = e.world.livingAgents().filter((x) => x.parentId === a!.id);
      expect(kids.length).toBe(1);
      const kid = kids[0]!;
      expect(e.nodes.has(kid.id)).toBe(true);
      await e.tick();
      await e.tick();
      // The child runs its own copy of onTick with its own state (its own counter starts at 0).
      expect(Number(kid.profile.ticks)).toBeGreaterThan(0);
      expect(Number(kid.profile.ticks)).toBeLessThan(Number(a!.profile.ticks));
    } finally {
      await e.shutdown();
    }
  });
});

describe("seasons", () => {
  test("seasons cycle by days and scale regrowth", () => {
    const w = mk({ ticksPerDay: 10, seasonDays: 2, regrowthPerTick: 0.1 });
    expect(w.season).toBe("spring");
    w.tick = 20;
    expect(w.season).toBe("summer");
    w.tick = 40;
    expect(w.season).toBe("autumn");
    w.tick = 60;
    expect(w.season).toBe("winter");
    w.tick = 80;
    expect(w.season).toBe("spring");
    expect(w.seasonProgress).toBe(0);
    w.tick = 65;
    expect(w.seasonProgress).toBeCloseTo(0.25, 5);
    const t = w.tiles.find((x) => x.foodCap === 20)!;
    t.food = 0;
    w.tick = 59; // next step lands in winter
    w.drainEvents();
    w.step();
    expect(t.food).toBeCloseTo(20 * 0.1 * SEASON_REGROWTH.winter, 5);
    expect(w.drainEvents().some((e) => e.kind === "season-changed" && e.data?.season === "winter")).toBe(true);
    expect(w.stateView().season).toBe("winter");
    expect(w.configView().seasonDays).toBe(2);
  });

  test("observe reports season and population", () => {
    const w = mk({ maxPopulation: 7 });
    const a = w.spawnAgent();
    const o = w.observe(a.id) as any;
    expect(o.season).toBe("spring");
    expect(o.population).toBe(1);
    expect(o.maxPopulation).toBe(7);
  });

  test("the cache is big enough to share scripts", () => {
    const w = mk();
    expect(w.config.cacheEntryBytes).toBeGreaterThanOrEqual(4096);
    expect(w.config.cacheMaxEntries).toBeGreaterThanOrEqual(200);
  });
});
