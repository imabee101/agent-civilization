import { describe, expect, test } from "bun:test";
import { World, WorldError } from "../../src/world/world";
import { hexDistance, hexNeighbor } from "../../src/world/hex";

function mk(extra = {}) {
  return new World({ seed: 5, mapRadius: 6, features: false, ...extra });
}

describe("World terrain", () => {
  test("generates a hexagonal map of the right size", () => {
    const w = mk();
    expect(w.tiles.length).toBe(1 + 3 * 6 * 7);
    for (const t of w.tiles) expect(hexDistance(t, { q: 0, r: 0 })).toBeLessThanOrEqual(6);
  });

  test("is deterministic for a seed", () => {
    const a = mk();
    const b = mk();
    expect(a.tiles).toEqual(b.tiles);
    expect(mk({ seed: 6 }).tiles).not.toEqual(a.tiles);
  });

  test("center is always land", () => {
    for (let seed = 1; seed < 30; seed++) {
      const w = new World({ seed, mapRadius: 8, features: false });
      expect(w.tileAt({ q: 0, r: 0 })!.terrain).not.toBe("water");
    }
  });

  test("food starts within cap and water/rock have no food", () => {
    const w = mk();
    for (const t of w.tiles) {
      expect(t.food).toBeLessThanOrEqual(t.foodCap);
      if (t.terrain === "water" || t.terrain === "rock") expect(t.foodCap).toBe(0);
    }
  });
});

describe("World agents and survival", () => {
  test("spawn places agent on land with unique id/name", () => {
    const w = mk();
    const a = w.spawnAgent();
    const b = w.spawnAgent({ name: a.name });
    expect(a.id).not.toBe(b.id);
    expect(b.name).not.toBe(a.name);
    expect(w.isPassable(a)).toBe(true);
    const ev = w.drainEvents();
    expect(ev.filter((e) => e.kind === "spawned").length).toBe(2);
  });

  test("agent starves and dies leaving a ruin with files intact", () => {
    const w = mk({ foodDrainPerTick: 50, starveHealthPerTick: 50 });
    const a = w.spawnAgent({ files: { "main.js": "// hi", "notes.txt": "keep me" } });
    w.drainEvents();
    let died = false;
    for (let i = 0; i < 20 && !died; i++) {
      w.step();
      died = !a.alive;
    }
    expect(died).toBe(true);
    expect(a.diedTick).toBeGreaterThan(0);
    expect(a.files["notes.txt"]).toBe("keep me");
    const kinds = w.drainEvents().map((e) => e.kind);
    expect(kinds).toContain("starving");
    expect(kinds).toContain("died");
    expect(w.stateView().ruins.length).toBe(1);
    expect(w.livingAgents().length).toBe(0);
  });

  test("eating restores food and prevents starvation", () => {
    const w = mk({ foodDrainPerTick: 5 });
    const a = w.spawnAgent();
    a.food = 10;
    a.inventory.food = 40;
    w.intentEat(a.id, 30);
    w.step();
    expect(a.food).toBeCloseTo(35, 5);
    expect(a.inventory.food).toBe(10);
    expect(w.drainEvents().some((e) => e.kind === "ate")).toBe(true);
  });

  test("eat is capped at 100 satiety and inventory", () => {
    const w = mk({ foodDrainPerTick: 0 });
    const a = w.spawnAgent();
    a.food = 95;
    a.inventory.food = 3;
    w.intentEat(a.id, 50);
    w.step();
    expect(a.food).toBe(98);
    expect(a.inventory.food).toBe(0);
  });

  test("gather takes food from the tile, costs energy, and respects inventory cap", () => {
    const w = mk();
    const a = w.spawnAgent();
    const tile = w.tileAt(a)!;
    tile.food = 30;
    tile.foodCap = 30;
    a.inventory.food = 0;
    const e0 = a.energy;
    w.intentGather(a.id);
    w.step();
    expect(a.inventory.food).toBe(w.config.gatherAmount);
    expect(tile.food).toBeCloseTo(30 - w.config.gatherAmount + 30 * w.config.regrowthPerTick, 5);
    expect(a.energy).toBeLessThan(e0);
    a.inventory.food = w.config.maxInventoryFood;
    w.intentGather(a.id);
    w.step();
    expect(a.inventory.food).toBe(w.config.maxInventoryFood);
    expect(a.log.some((l) => l.includes("no room for more food"))).toBe(true);
  });

  test("drop puts food on the tile so another node can gather it", () => {
    const w = mk({ regrowthPerTick: 0 });
    const a = w.spawnAgent();
    const b = w.spawnAgent({ at: { q: a.q, r: a.r } });
    const tile = w.tileAt(a)!;
    tile.food = 0;
    a.inventory.food = 20;
    b.inventory.food = 0;
    w.intentDrop(a.id, 15);
    w.step();
    expect(a.inventory.food).toBe(5);
    expect(tile.food).toBe(15);
    w.intentGather(b.id);
    w.step();
    expect(b.inventory.food).toBe(w.config.gatherAmount);
  });

  test("move changes position, is blocked by water/edge, and costs energy", () => {
    const w = mk({ mapRadius: 2 });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const before = { q: a.q, r: a.r };
    // find a passable neighbour
    let dir = -1;
    for (let d = 0; d < 6; d++) if (w.isPassable(hexNeighbor(before, d))) dir = d;
    expect(dir).toBeGreaterThanOrEqual(0);
    w.intentMove(a.id, dir);
    w.step();
    expect(hexDistance(a, before)).toBe(1);
    // walk off the edge
    a.q = 2;
    a.r = 0;
    w.intentMove(a.id, "e");
    w.step();
    expect(a.q).toBe(2);
    expect(a.log.at(-1)).toContain("blocked");
  });

  test("moving while too tired fails", () => {
    const w = mk();
    const a = w.spawnAgent();
    a.energy = 0.5;
    const before = { q: a.q, r: a.r };
    w.intentMove(a.id, 0);
    w.step();
    expect(a.q).toBe(before.q);
    expect(a.r).toBe(before.r);
  });

  test("rest restores energy", () => {
    const w = mk();
    const a = w.spawnAgent();
    a.energy = 10;
    w.intentRest(a.id);
    w.step();
    expect(a.energy).toBeCloseTo(10 + w.config.restEnergy - w.config.energyDrainPerTick, 5);
  });

  test("moveToward steps closer and avoids water", () => {
    const w = mk({ mapRadius: 8 });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const target = { q: 5, r: -2 };
    let steps = 0;
    while (hexDistance(a, target) > 0 && steps < 40) {
      const ok = w.intentMoveToward(a.id, target.q, target.r);
      w.step();
      a.energy = 100;
      if (!ok) break;
      steps++;
    }
    // Either reached or got as close as land allows.
    expect(hexDistance(a, target)).toBeLessThanOrEqual(hexDistance({ q: 0, r: 0 }, target));
    expect(steps).toBeGreaterThan(0);
  });

  test("invalid intents throw WorldError without changing state", () => {
    const w = mk();
    const a = w.spawnAgent();
    expect(() => w.intentMove(a.id, "up")).toThrow(WorldError);
    expect(() => w.intentEat(a.id, "lots")).toThrow(WorldError);
    expect(() => w.intentSay(a.id, 42)).toThrow(WorldError);
    expect(() => w.intentMoveToward(a.id, "a", 1)).toThrow(WorldError);
    expect(() => w.getAgent("nope")).toThrow(WorldError);
  });

  test("dead nodes cannot act", () => {
    const w = mk();
    const a = w.spawnAgent();
    a.alive = false;
    expect(() => w.intentMove(a.id, 0)).toThrow(/dead/);
    expect(() => w.fsWrite(a.id, "x", "y")).toThrow(/dead/);
  });
});

describe("World body actions", () => {
  test("one body action per tick: the last call wins and the replaced one is logged", () => {
    const w = mk();
    const a = w.spawnAgent({});
    a.energy = 100;
    const start = { q: a.q, r: a.r };
    w.intentMove(a.id, 0);
    w.intentRest(a.id);
    w.step();
    expect({ q: a.q, r: a.r }).toEqual(start);
    expect(a.log.some((l) => l.includes("move replaced by rest"))).toBe(true);
    w.intentRest(a.id);
    w.intentRest(a.id);
    w.step();
    expect(a.log.filter((l) => l.includes("replaced")).length).toBe(1);
  });
});

describe("World speech and messages", () => {
  test("say is heard only within hearRadius", () => {
    const w = mk({ hearRadius: 2, mapRadius: 8 });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const near = w.spawnAgent({ at: { q: 1, r: 0 } });
    const far = w.spawnAgent({ at: { q: 5, r: 0 } });
    w.drainEvents();
    w.intentSay(a.id, "hello there");
    w.step();
    const d = w.drainDeliveries();
    expect(d.filter((x) => x.kind === "hear").map((x) => x.to)).toEqual([near.id]);
    expect(near.heard.at(-1)!.text).toBe("hello there");
    expect(far.heard.length).toBe(0);
    const spoke = w.drainEvents().find((e) => e.kind === "spoke")!;
    expect(spoke.quote).toBe("hello there");
    expect(spoke.agentId).toBe(a.id);
  });

  test("say is truncated to maxSayChars", () => {
    const w = mk({ maxSayChars: 5 });
    const a = w.spawnAgent();
    w.intentSay(a.id, "0123456789");
    w.step();
    expect(a.lastSaid!.text).toBe("01234");
  });

  test("send delivers bytes verbatim to a node in range, next tick", () => {
    const w = mk({ mapRadius: 8, sendRadius: 4 });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const b = w.spawnAgent({ at: { q: 2, r: 0 } });
    const payload = JSON.stringify({ cmd: "anything", n: 1 });
    w.intentSend(a.id, b.id, payload);
    expect(w.drainDeliveries()).toEqual([]);
    w.step();
    const d = w.drainDeliveries();
    expect(d).toEqual([{ kind: "message", to: b.id, from: a.id, payload }]);
    expect(b.inbox.at(-1)!.payload).toBe(payload);
  });

  test("send enforces range, size, per-tick count, and living target", () => {
    const w = mk({ mapRadius: 10, sendRadius: 3, maxMessageBytes: 10, maxSendsPerTick: 2 });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const b = w.spawnAgent({ at: { q: 1, r: 0 } });
    const far = w.spawnAgent({ at: { q: 6, r: 0 } });
    expect(() => w.intentSend(a.id, far.id, '"x"')).toThrow(/out of range/);
    expect(() => w.intentSend(a.id, b.id, '"0123456789abc"')).toThrow(/exceeds/);
    expect(() => w.intentSend(a.id, "zzz", '"x"')).toThrow(/no living node/);
    w.intentSend(a.id, b.id, '"1"');
    w.intentSend(a.id, b.id, '"2"');
    expect(() => w.intentSend(a.id, b.id, '"3"')).toThrow(/at most 2/);
    b.alive = false;
    expect(() => w.intentSend(a.id, b.id, '"x"')).toThrow(/no living node/);
  });

  test("the engine never interprets message content", () => {
    const w = mk({ mapRadius: 8 });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const b = w.spawnAgent({ at: { q: 1, r: 0 } });
    const bFood = b.food;
    const bFiles = { ...b.files };
    w.intentSend(a.id, b.id, JSON.stringify({ type: "attack", damage: 999, cmd: "fs.remove('main.js')" }));
    w.step();
    expect(b.alive).toBe(true);
    expect(b.food).toBeCloseTo(bFood - w.config.foodDrainPerTick, 5);
    expect(b.files).toEqual(bFiles);
  });
});

describe("World files, ruins, profile", () => {
  test("fs write/read/list/remove with quota and file-count limits", () => {
    const w = mk({ fsQuotaBytes: 100, fsMaxFiles: 2 });
    const a = w.spawnAgent();
    w.fsWrite(a.id, "main.js", "abc");
    expect(w.fsRead(a.id, "main.js")).toBe("abc");
    expect(w.fsRead(a.id, "nope.txt")).toBeNull();
    w.fsWrite(a.id, "b.txt", "x");
    expect(() => w.fsWrite(a.id, "c.txt", "x")).toThrow(/at most 2 files/);
    expect(() => w.fsWrite(a.id, "b.txt", "y".repeat(200))).toThrow(/quota/);
    expect(w.fsList(a.id).map((f) => f.path).sort()).toEqual(["b.txt", "main.js"]);
    expect(w.fsRemove(a.id, "b.txt")).toBe(true);
    expect(w.fsRemove(a.id, "b.txt")).toBe(false);
    expect(w.fsBytes(a.id)).toBe("main.js".length + 3);
  });

  test("fs rejects hostile paths", () => {
    const w = mk();
    const a = w.spawnAgent();
    for (const p of ["../x", "/etc/passwd", "a/../b", "", "x".repeat(200), "sp ace", "a;b", 42, null]) {
      expect(() => w.fsWrite(a.id, p as string, "x")).toThrow(WorldError);
    }
    expect(() => w.fsWrite(a.id, "ok.txt", 12 as unknown as string)).toThrow(/string/);
  });

  test("quota counts UTF-8 bytes, not chars", () => {
    const w = mk({ fsQuotaBytes: 12 });
    const a = w.spawnAgent();
    // "a.txt" = 5 bytes; "ééé" = 6 bytes => 11 ok; "éééé" = 8 => 13 not ok
    w.fsWrite(a.id, "a.txt", "ééé");
    expect(() => w.fsWrite(a.id, "a.txt", "éééé")).toThrow(/quota/);
  });

  test("ruin files are readable only when adjacent and only when dead", () => {
    const w = mk({ mapRadius: 8 });
    const dead = w.spawnAgent({ at: { q: 0, r: 0 }, files: { "main.js": "secret" } });
    const reader = w.spawnAgent({ at: { q: 1, r: 0 } });
    expect(() => w.ruinFiles(reader.id, dead.id)).toThrow(/no ruin/);
    dead.alive = false;
    dead.diedTick = 1;
    expect(w.ruinFiles(reader.id, dead.id)).toEqual([{ path: "main.js", bytes: 6 }]);
    expect(w.ruinRead(reader.id, dead.id, "main.js")).toBe("secret");
    expect(w.ruinRead(reader.id, dead.id, "none")).toBeNull();
    reader.q = 3;
    expect(() => w.ruinRead(reader.id, dead.id, "main.js")).toThrow(/not adjacent/);
    expect(w.drainEvents().some((e) => e.kind === "ruin-read" && e.targetId === dead.id)).toBe(true);
  });

  test("profile set/clear with limits; the engine gives keys no meaning", () => {
    const w = mk({ maxProfileKeys: 2, maxProfileValueChars: 4 });
    const a = w.spawnAgent();
    w.drainEvents();
    w.setProfile(a.id, "group", "northerners");
    expect(a.profile.group).toBe("nort");
    w.setProfile(a.id, "status", "ok");
    expect(() => w.setProfile(a.id, "third", "x")).toThrow(/at most 2/);
    expect(() => w.setProfile(a.id, "bad key!", "x")).toThrow();
    w.setProfile(a.id, "status", null);
    expect(a.profile.status).toBeUndefined();
    const evs = w.drainEvents().filter((e) => e.kind === "profile-changed");
    expect(evs.length).toBe(3);
    expect(evs[0]!.importance).toBe(2);
  });
});

describe("World perception", () => {
  test("observe includes tiles/nodes/ruins within vision only", () => {
    const w = mk({ mapRadius: 10, visionRadius: 2, nightVisionRadius: 1, ticksPerDay: 100 });
    const me = w.spawnAgent({ at: { q: 0, r: 0 } });
    const near = w.spawnAgent({ at: { q: 2, r: 0 } });
    const far = w.spawnAgent({ at: { q: 5, r: 0 } });
    const ruin = w.spawnAgent({ at: { q: 0, r: 1 } });
    ruin.alive = false;
    const o = w.observe(me.id) as any;
    expect(o.me.id).toBe(me.id);
    expect(o.nodes.map((n: any) => n.id)).toEqual([near.id]);
    expect(o.ruins.map((n: any) => n.id)).toEqual([ruin.id]);
    expect(o.tiles.length).toBe(19);
    for (const t of o.tiles) expect(t.dist).toBeLessThanOrEqual(2);
    expect(far.id).not.toBe(near.id);
    // night shrinks vision
    w.tick = 80;
    expect(w.phase).toBe("night");
    const n = w.observe(me.id) as any;
    expect(n.visionRadius).toBe(1);
    expect(n.nodes.length).toBe(0);
  });

  test("day/phase progress", () => {
    const w = mk({ ticksPerDay: 100 });
    expect(w.day).toBe(1);
    expect(w.phase).toBe("dawn");
    w.tick = 30;
    expect(w.phase).toBe("day");
    w.tick = 60;
    expect(w.phase).toBe("dusk");
    w.tick = 90;
    expect(w.phase).toBe("night");
    w.tick = 100;
    expect(w.day).toBe(2);
    expect(w.dayProgress).toBe(0);
  });
});

describe("World snapshot", () => {
  test("snapshot/restore round-trips and continues deterministically", () => {
    const w = mk({ mapRadius: 6 });
    const a = w.spawnAgent({ files: { "main.js": "x" } });
    w.setProfile(a.id, "group", "g");
    w.spawnAgent();
    for (let i = 0; i < 10; i++) {
      w.intentMove(a.id, i % 6);
      w.step();
    }
    const snap = JSON.parse(JSON.stringify(w.snapshot()));
    const w2 = World.restore(snap);
    expect(w2.tick).toBe(w.tick);
    expect(w2.stateView()).toEqual(w.stateView());
    expect(w2.tiles).toEqual(w.tiles);
    expect(w2.getAgent(a.id).files).toEqual({ "main.js": "x" });
    // both continue identically
    for (let i = 0; i < 10; i++) {
      w.step();
      w2.step();
    }
    expect(w2.stateView()).toEqual(w.stateView());
    expect(w2.rng.getState()).toBe(w.rng.getState());
  });

  test("restore rejects unknown versions", () => {
    expect(() => World.restore({ version: 3 } as any)).toThrow();
  });

  test("reset clears agents and regenerates terrain", () => {
    const w = mk();
    w.spawnAgent();
    w.step();
    w.reset(99);
    expect(w.agents.size).toBe(0);
    expect(w.tick).toBe(0);
    expect(w.config.seed).toBe(99);
    expect(w.tiles).toEqual(new World({ seed: 99, mapRadius: 6, features: false }).tiles);
  });
});

describe("no engine-authored social rules", () => {
  test("world source contains no social mechanics vocabulary", async () => {
    const src = (await Bun.file(new URL("../../src/world/world.ts", import.meta.url)).text()).toLowerCase();
    // These words may appear only in the header comment explaining their absence.
    const body = src.slice(src.indexOf("import "));
    for (const word of ["faction", "alliance", "attack(", "steal", "sabotage", "betray", "hack", "backdoor", "reputation", "opinion"]) {
      expect(body.includes(word)).toBe(false);
    }
  });

  test("speaking and sending cost energy; a tired node stays silent", () => {
    const w = mk();
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const b = w.spawnAgent({ at: { q: 1, r: 0 } });
    a.energy = 10;
    w.intentSay(a.id, "hi");
    w.intentSend(a.id, b.id, JSON.stringify({ k: 1 }));
    w.step();
    expect(a.energy).toBeCloseTo(10 - w.config.sayEnergy - w.config.sendEnergy - w.config.energyDrainPerTick, 5);
    expect(b.heard.length).toBe(1);
    expect(b.inbox.length).toBe(1);
    a.energy = 0.5;
    w.intentSay(a.id, "again");
    w.intentSend(a.id, b.id, "1");
    w.step();
    expect(b.heard.length).toBe(1);
    expect(b.inbox.length).toBe(1);
    expect(a.log.some((l) => l.includes("say: too tired"))).toBe(true);
    expect(a.log.some((l) => l.includes("send: too tired"))).toBe(true);
  });

  test("at most two sends per tick", () => {
    const w = mk();
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const b = w.spawnAgent({ at: { q: 1, r: 0 } });
    w.intentSend(a.id, b.id, "1");
    w.intentSend(a.id, b.id, "2");
    expect(() => w.intentSend(a.id, b.id, "3")).toThrow(/at most 2/);
  });
});
