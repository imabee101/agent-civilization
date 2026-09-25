import { describe, expect, test } from "bun:test";
import { World, WorldError } from "../../src/world/world";
import { hexDistance, hexNeighbor, hexesWithin } from "../../src/world/hex";
import * as lore from "../../src/world/features";
const { ANCIENT_RUINS, INITIAL_CACHE_ENTRIES } = lore;

function mk(extra = {}) {
  return new World({ seed: 9, mapRadius: 9, foodDrainPerTick: 0, ...extra });
}

function structures(w: World) {
  return w.tiles.filter((t) => t.structure).map((t) => t.structure!.kind);
}

describe("world generation places nuggets", () => {
  test("cache, plaque, springs, towers, boards, vault exist and are deterministic", () => {
    const w = mk();
    const kinds = structures(w);
    expect(kinds.filter((k) => k === "cache").length).toBe(1);
    expect(kinds.filter((k) => k === "plaque").length).toBe(2);
    expect(kinds.filter((k) => k === "spring").length).toBe(w.config.springs + w.config.outerSprings);
    expect(kinds.filter((k) => k === "tower").length).toBe(w.config.towers);
    expect(kinds.filter((k) => k === "board").length).toBe(w.config.boards);
    expect(kinds.filter((k) => k === "vault").length).toBe(2);
    expect(kinds.filter((k) => k === "gate").length).toBe(1);
    expect(structures(mk())).toEqual(kinds);
    expect(mk().tiles).toEqual(w.tiles);
  });

  test("the cache is at the centre with its initial entries; the vault is far and locked and stocked", () => {
    const w = mk();
    const cache = w.tiles.find((t) => t.structure?.kind === "cache")!;
    expect(hexDistance(cache, { q: 0, r: 0 })).toBeLessThanOrEqual(1);
    expect(Object.keys(cache.structure!.entries!).sort()).toEqual(INITIAL_CACHE_ENTRIES.map((e) => e.name).sort());
    const vault = w.tiles.find((t) => t.structure?.kind === "vault")!;
    expect(vault.structure!.locked).toBe(true);
    expect(vault.food).toBeGreaterThan(50);
    expect(vault.items).toContain("relay");
    expect(hexDistance(vault, cache)).toBeGreaterThanOrEqual(5);
  });

  test("ancient ruins are dead nodes with files, placed near what they talk about", () => {
    const w = mk();
    const ruins = w.deadAgents();
    expect(ruins.map((r) => r.name).sort()).toEqual(ANCIENT_RUINS.map((r) => r.name).sort());
    for (const r of ruins) {
      expect(r.diedTick).toBe(0);
      expect(Object.keys(r.files).length).toBeGreaterThan(0);
      expect(r.inventory.items).toEqual([]);
    }
    const cart = ruins.find((r) => r.name === "Cartographer")!;
    expect(cart.files["map.txt"]).toContain("cache");
    expect(cart.files["map.txt"]).toContain("something buried");
    const cache = w.tiles.find((t) => t.structure?.kind === "cache")!;
    const phase = ruins.find((r) => r.name === "Phaseone")!;
    expect(hexDistance(phase, cache)).toBeLessThanOrEqual(2);
    expect(w.livingAgents().length).toBe(0);
    expect(w.drainEvents()).toEqual([]);
  });

  test("hidden items exist but are not visible in tile views or observe until found", () => {
    const w = mk();
    const buried = w.tiles.filter((t) => t.hidden.length > 0);
    expect(buried.length).toBeGreaterThanOrEqual(4);
    const kinds = buried.flatMap((t) => t.hidden);
    expect(kinds).toContain("key");
    for (const t of buried) {
      expect(w.tileView(t).items).toBeUndefined();
      expect((w.tileView(t) as any).hidden).toBeUndefined();
    }
    const spot = buried[0]!;
    const a = w.spawnAgent({ at: hexNeighbor(spot, 0) });
    if (!w.isPassable(hexNeighbor(spot, 0))) return; // rare: neighbour is water; the reveal test below covers the mechanic
    const seen = (w.observe(a.id) as any).tiles.find((t: any) => t.q === spot.q && t.r === spot.r);
    expect(seen?.items).toBeUndefined();
  });

  test("new nodes spawn near the cache", () => {
    const w = mk();
    const cache = w.tiles.find((t) => t.structure?.kind === "cache")!;
    for (let i = 0; i < 6; i++) {
      const a = w.spawnAgent();
      expect(hexDistance(a, cache)).toBeLessThanOrEqual(w.config.spawnRadius);
    }
  });

  test("features:false gives a bare world", () => {
    const w = mk({ features: false });
    expect(structures(w)).toEqual([]);
    expect(w.agents.size).toBe(0);
    expect(w.moatRadius()).toBe(0);
  });
});

describe("the enclosure", () => {
  const origin = { q: 0, r: 0 };
  const gateOf = (w: World) => w.tiles.find((t) => t.structure?.kind === "gate")!;

  test("a ring of water at half the radius, one causeway with a locked gate, land on both sides of it", () => {
    const w = mk();
    const m = w.moatRadius();
    expect(m).toBe(4);
    const ring = w.tiles.filter((t) => hexDistance(t, origin) === m);
    const gate = gateOf(w);
    expect(gate.structure!.locked).toBe(true);
    expect(hexDistance(gate, origin)).toBe(m);
    for (const t of ring) if (t !== gate) expect(t.terrain).toBe("water");
    const sides = hexesWithin(gate, 1).filter((h) => hexDistance(h, origin) !== m).map((h) => w.tileAt(h)!);
    expect(sides.some((t) => hexDistance(t, origin) < m && t.terrain !== "water")).toBe(true);
    expect(sides.some((t) => hexDistance(t, origin) > m && t.terrain !== "water")).toBe(true);
    expect(mk().tiles).toEqual(w.tiles);
  });

  test("the cache, plaque, monolith, key, first spring and the map board are inside; the far plaque, stash and outer springs are outside", () => {
    const w = mk();
    const inside = (t: { q: number; r: number }) => w.isInner(t);
    for (const kind of ["cache", "monolith"] as const) expect(inside(w.tiles.find((t) => t.structure?.kind === kind)!)).toBe(true);
    const plaques = w.tiles.filter((t) => t.structure?.kind === "plaque");
    expect(plaques.filter(inside).length).toBe(1);
    expect(plaques.filter((t) => !inside(t))[0]!.structure!.text).toBe(lore.FAR_PLAQUE_TEXT);
    expect(inside(w.tiles.find((t) => t.hidden.includes("key"))!)).toBe(true);
    expect(inside(w.tiles.find((t) => t.items.includes("map"))!)).toBe(true);
    const springs = w.tiles.filter((t) => t.structure?.kind === "spring");
    expect(springs.some(inside)).toBe(true);
    const outerSprings = springs.filter((t) => !inside(t));
    expect(outerSprings.length).toBeGreaterThanOrEqual(w.config.outerSprings);
    for (const t of outerSprings.filter((t) => t.foodCap === 100)) expect(t.food).toBe(100);
    const stash = w.tiles.find((t) => t.structure?.kind === "vault" && !t.structure.locked)!;
    expect(inside(stash)).toBe(false);
    expect(stash.food).toBe(200);
    expect(stash.items).toEqual(["seeds", "relay", "lantern"]);
    const cart = w.deadAgents().find((r) => r.name === "Cartographer")!;
    expect(cart.files["map.txt"]).toContain("gate");
  });

  test("the gate blocks a keyless node, opens for a key holder once, then stays open for everyone", () => {
    const w = mk();
    const gate = gateOf(w);
    const m = w.moatRadius();
    const shore = hexesWithin(gate, 1).map((h) => w.tileAt(h)!).find((t) => hexDistance(t, origin) < m && t.terrain !== "water")!;
    const a = w.spawnAgent({ at: shore });
    w.drainEvents();
    const dir = [0, 1, 2, 3, 4, 5].find((d) => hexNeighbor(a, d).q === gate.q && hexNeighbor(a, d).r === gate.r)!;
    expect(w.isPassable(gate, a)).toBe(false);
    w.intentMove(a.id, dir);
    w.step();
    expect(hexDistance(a, origin)).toBe(m - 1);
    a.inventory.items.push("key");
    w.intentMove(a.id, dir);
    w.step();
    expect(hexDistance(a, origin)).toBe(m);
    expect(gate.structure!.locked).toBe(false);
    const evs = w.drainEvents();
    const opened = evs.filter((e) => e.kind === "gate-opened");
    expect(opened.length).toBe(1);
    expect(opened[0]!.importance).toBe(3);
    expect(evs.find((e) => e.kind === "moved" && e.data?.onto === "gate")).toBeDefined();
    const b = w.spawnAgent({ at: shore });
    expect(w.isPassable(gate, b)).toBe(true);
    expect(() => w.intentDemolish(a.id)).toThrow(/cannot be demolished/);
  });

  test("newcomers walk in from the inner shore, not from beyond the water", () => {
    const w = mk();
    const m = w.moatRadius();
    for (let i = 0; i < 6; i++) {
      const a = w.spawnAgent({ arrival: true });
      expect(hexDistance(a, origin)).toBe(m - 1);
    }
  });

  test("enclosure:false keeps the open disc", () => {
    const w = mk({ enclosure: false });
    expect(w.moatRadius()).toBe(0);
    expect(w.tiles.some((t) => t.structure?.kind === "gate")).toBe(false);
    expect(w.tiles.filter((t) => t.structure?.kind === "plaque").length).toBe(1);
  });

  test("a world saved before the ring existed gets one on restore; whatever stood on the ring is moved off it", () => {
    const w = mk({ enclosure: false });
    const m = 4;
    const ringLand = w.tiles.find((t) => hexDistance(t, origin) === m && t.terrain !== "water" && !t.structure)!;
    ringLand.structure = { kind: "tower" };
    ringLand.items.push("lantern");
    const standing = w.spawnAgent({ at: ringLand });
    const snap = w.snapshot();
    snap.config.enclosure = true;
    const r = World.restore(snap);
    expect(r.moatRadius()).toBe(m);
    const ring = r.tiles.filter((t) => hexDistance(t, origin) === m);
    const gates = ring.filter((t) => t.structure?.kind === "gate");
    expect(gates.length).toBe(1);
    for (const t of ring) if (t.structure?.kind !== "gate") expect(t.terrain).toBe("water");
    expect(r.tiles.filter((t) => t.structure?.kind === "tower").length).toBe(w.config.towers + 1);
    expect(r.tiles.some((t) => t.items.includes("lantern") && hexDistance(t, origin) !== m)).toBe(true);
    const moved = r.getAgent(standing.id);
    expect(hexDistance(moved, origin)).not.toBe(m);
    expect(r.isPassable(moved)).toBe(true);
    expect(World.restore(r.snapshot()).tiles.filter((t) => t.structure?.kind === "gate").length).toBe(1);
  });
});

describe("items", () => {
  test("standing on a buried item reveals it; take/dropItem move it; death drops everything", () => {
    const w = mk({ features: false });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const n = hexNeighbor(a, 0);
    const t = w.tileAt(n)!;
    t.terrain = "grass";
    t.hidden.push("lantern");
    w.drainEvents();
    w.intentMove(a.id, 0);
    w.step();
    expect(t.hidden).toEqual([]);
    expect(t.items).toEqual(["lantern"]);
    expect(w.drainEvents().some((e) => e.kind === "found" && e.agentId === a.id)).toBe(true);
    expect(w.drainDirtyTiles().some((v) => v.q === t.q && v.r === t.r && v.items?.includes("lantern"))).toBe(true);
    expect(w.take(a.id)).toBe("lantern");
    expect(a.inventory.items).toEqual(["lantern"]);
    expect(t.items).toEqual([]);
    expect(() => w.take(a.id)).toThrow(/nothing to take/);
    expect(() => w.dropItem(a.id, "key")).toThrow(/not carrying/);
    a.inventory.wood = 5;
    a.inventory.food = 7;
    // starve it
    w.config.foodDrainPerTick = 100;
    w.config.starveHealthPerTick = 100;
    a.food = 0;
    w.step();
    w.step();
    expect(a.alive).toBe(false);
    expect(t.items).toEqual(["lantern"]);
    expect(t.wood).toBeGreaterThanOrEqual(5);
    expect(t.food).toBeGreaterThanOrEqual(7);
    expect(a.inventory).toEqual({ food: 0, wood: 0, stone: 0, items: [] });
  });

  test("carrying limit and named take", () => {
    const w = mk({ features: false, maxItems: 2 });
    const a = w.spawnAgent();
    const t = w.tileAt(a)!;
    t.items.push("seeds", "key", "relay");
    expect(w.take(a.id, "key")).toBe("key");
    expect(() => w.take(a.id, "lantern")).toThrow(/no lantern/);
    w.take(a.id);
    expect(() => w.take(a.id)).toThrow(/at most 2/);
    expect(w.dropItem(a.id, "key")).toBe("key");
    expect(t.items).toContain("key");
  });

  test("taking the map writes map.txt into your files", () => {
    const w = mk();
    const board = w.tiles.find((t) => t.items.includes("map"))!;
    const a = w.spawnAgent({ at: board });
    expect(a.q).toBe(board.q);
    w.take(a.id, "map");
    expect(a.files["map.txt"]).toContain("CARTOGRAPHER");
  });

  test("lantern restores night vision; relay doubles send range; towers reach the map", () => {
    const w = mk({ features: false, ticksPerDay: 100, visionRadius: 3, nightVisionRadius: 1, sendRadius: 4, towerSendRadius: 99 });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    w.tick = 80; // night
    expect(w.visionRadiusFor(a)).toBe(1);
    a.inventory.items.push("lantern");
    expect(w.visionRadiusFor(a)).toBe(3);
    expect(w.sendRadiusFor(a)).toBe(4);
    a.inventory.items.push("relay");
    expect(w.sendRadiusFor(a)).toBe(8);
    w.tileAt(hexNeighbor(a, 2))!.structure = { kind: "tower" };
    expect(w.sendRadiusFor(a)).toBe(99);
    const far = w.spawnAgent({ at: { q: 8, r: 0 } });
    if (far.q === 8) {
      w.intentSend(a.id, far.id, '"hi"'); // in range thanks to the tower
      w.step();
      expect(far.inbox.length).toBe(1);
    }
  });

  test("seeds + plant raise the food cap and consume the seeds", () => {
    const w = mk({ features: false });
    const a = w.spawnAgent();
    const t = w.tileAt(a)!;
    t.terrain = "grass";
    t.foodCap = 20;
    expect(() => w.intentPlant(a.id)).toThrow(/needs seeds/);
    a.inventory.items.push("seeds");
    w.intentPlant(a.id);
    w.step();
    expect(t.foodCap).toBe(40);
    expect(a.inventory.items).toEqual([]);
    expect(w.drainEvents().some((e) => e.kind === "planted")).toBe(true);
  });
});

describe("structures", () => {
  test("gathering wood and stone; building costs materials and energy; demolish", () => {
    const w = mk({ features: false, materialRegrowthPerTick: 0 });
    const a = w.spawnAgent();
    const t = w.tileAt(a)!;
    t.wood = 10;
    t.stone = 10;
    w.intentGather(a.id, "wood");
    w.step();
    expect(a.inventory.wood).toBe(w.config.gatherWoodAmount);
    expect(t.wood).toBe(10 - w.config.gatherWoodAmount);
    w.intentGather(a.id, "stone");
    w.step();
    expect(a.inventory.stone).toBe(w.config.gatherStoneAmount);
    expect(() => w.intentGather(a.id, "gold")).toThrow(WorldError);
    expect(() => w.intentBuild(a.id, "board")).toThrow(/needs 4 wood/);
    expect(() => w.intentBuild(a.id, "castle")).toThrow(/must be one of/);
    w.drainEvents();
    w.intentBuild(a.id, "sign", "keep out");
    const e0 = a.energy;
    w.step();
    expect(t.structure).toMatchObject({ kind: "sign", text: "keep out", builtBy: a.id });
    expect(a.inventory.wood).toBe(w.config.gatherWoodAmount - 1);
    expect(a.energy).toBeLessThan(e0);
    expect(w.drainEvents().some((e) => e.kind === "built" && e.quote === "keep out")).toBe(true);
    // anyone can rewrite a sign; anyone can demolish
    const b = w.spawnAgent({ at: t });
    w.signWrite(b.id, "welcome");
    expect(t.structure!.text).toBe("welcome");
    w.intentDemolish(b.id);
    w.step();
    expect(t.structure).toBeUndefined();
    expect(w.drainEvents().some((e) => e.kind === "demolished")).toBe(true);
    expect(() => w.intentDemolish(b.id)).toThrow(/nothing to demolish/);
    expect(() => w.signWrite(b.id, "x")).toThrow(/no sign/);
  });

  test("walls block movement and vault doors open for a key holder", () => {
    const w = mk({ features: false });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const n = hexNeighbor(a, 0);
    const t = w.tileAt(n)!;
    t.terrain = "grass";
    t.structure = { kind: "wall" };
    w.intentMove(a.id, 0);
    w.step();
    expect(a.q).toBe(0);
    expect(w.isPassable(n)).toBe(false);
    t.structure = { kind: "vault", locked: true };
    w.intentMove(a.id, 0);
    w.step();
    expect(a.q).toBe(0);
    a.inventory.items.push("key");
    w.drainEvents();
    w.intentMove(a.id, 0);
    w.step();
    expect(a.q).toBe(n.q);
    expect(t.structure!.locked).toBe(false);
    expect(w.drainEvents().some((e) => e.kind === "vault-opened" && e.importance === 3)).toBe(true);
    // once open, anyone can walk in
    const b = w.spawnAgent({ at: { q: 0, r: 0 } });
    expect(w.isPassable(n, b)).toBe(true);
  });

  test("springs regrow fast; plaques and springs cannot be demolished", () => {
    const w = mk({ features: false, regrowthPerTick: 0.001, springRegrowthPerTick: 0.1 });
    const a = w.spawnAgent();
    const t = w.tileAt(a)!;
    t.structure = { kind: "spring" };
    t.foodCap = 60;
    t.food = 0;
    w.step();
    expect(t.food).toBeCloseTo(6, 5);
    expect(() => w.intentDemolish(a.id)).toThrow(/cannot be demolished/);
  });

  test("boards: read/post from on or next to the board, with limits", () => {
    const w = mk({ features: false, boardMaxPosts: 2, boardPostChars: 5 });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const t = w.tileAt(hexNeighbor(a, 1))!;
    t.terrain = "grass";
    expect(() => w.boardRead(a.id)).toThrow(/no board/);
    t.structure = { kind: "board", posts: [] };
    expect(w.boardRead(a.id)).toEqual([]);
    w.boardPost(a.id, "first!");
    w.boardPost(a.id, "second");
    w.boardPost(a.id, "third");
    expect(w.boardRead(a.id).map((p) => p.text)).toEqual(["secon", "third"]);
    expect(w.boardRead(a.id)[0]).toMatchObject({ by: a.id, byName: a.name, tick: 0 });
    expect(() => w.boardPost(a.id, "")).toThrow();
    const evs = w.drainEvents().filter((e) => e.kind === "posted");
    expect(evs.length).toBe(3);
    expect(evs[0]!.quote).toBe("first");
    // walking away loses access
    a.q = 3;
    expect(() => w.boardRead(a.id)).toThrow(/no board/);
  });

  test("the cache: mkdir/write/read/list/rmdir with names as messages, capacity and validation", () => {
    const w = mk({ features: false, cacheMaxEntries: 2, cacheEntryBytes: 5, cacheNameChars: 10 });
    const a = w.spawnAgent({ at: { q: 0, r: 0 } });
    const t = w.tileAt(a)!;
    expect(() => w.cacheList(a.id)).toThrow(/no cache/);
    t.structure = { kind: "cache", entries: {} };
    w.cacheWrite(a.id, "hello-all", "");
    w.cacheWrite(a.id, "note", "abc");
    expect(() => w.cacheWrite(a.id, "third", "")).toThrow(/full/);
    expect(() => w.cacheWrite(a.id, "note", "toolong")).toThrow(/limited/);
    expect(() => w.cacheWrite(a.id, "bad name!", "")).toThrow(/only contain/);
    expect(() => w.cacheWrite(a.id, "..", "")).toThrow();
    expect(() => w.cacheWrite(a.id, "x".repeat(11), "")).toThrow(/1\.\.10/);
    expect(w.cacheRead(a.id, "note")).toBe("abc");
    expect(w.cacheRead(a.id, "nope")).toBeNull();
    const list = w.cacheList(a.id);
    expect(list.map((e) => e.name).sort()).toEqual(["hello-all", "note"]);
    expect((list[0] as any).text).toBeUndefined();
    expect(list.find((e) => e.name === "note")).toMatchObject({ by: a.id, byName: a.name, bytes: 3 });
    // anyone can overwrite and remove; that's the whole protocol
    const b = w.spawnAgent({ at: { q: 0, r: 0 } });
    w.cacheWrite(b.id, "note", "zzz");
    expect(w.cacheRead(a.id, "note")).toBe("zzz");
    expect(w.cacheRemove(b.id, "hello-all")).toBe(true);
    expect(w.cacheRemove(b.id, "hello-all")).toBe(false);
    expect(w.drainEvents().filter((e) => e.kind === "cached").length).toBe(4);
    expect(w.tileView(t).structure!.entries!.length).toBe(1);
  });

  test("observe describes structures and items without contents; tile views carry contents", () => {
    const w = mk();
    const cache = w.tiles.find((t) => t.structure?.kind === "cache")!;
    const a = w.spawnAgent({ at: cache });
    const o = w.observe(a.id) as any;
    expect(o.me.structure).toMatchObject({ kind: "cache", entries: INITIAL_CACHE_ENTRIES.length });
    expect(o.me.sendRadius).toBe(w.config.sendRadius);
    const here = o.tiles.find((t: any) => t.dist === 0);
    expect(here.structure.kind).toBe("cache");
    expect(here.structure.entries).toBe(INITIAL_CACHE_ENTRIES.length);
    const view = w.tileView(cache);
    expect(view.structure!.entries!.map((e) => e.name)).toContain("README");
    expect(w.cacheRead(a.id, "README")).toContain("Directory names are the message");
  });

  test("dirty tiles are reported once", () => {
    const w = mk();
    expect(w.drainDirtyTiles().length).toBeGreaterThan(0);
    expect(w.drainDirtyTiles()).toEqual([]);
    const a = w.spawnAgent();
    const t = w.tileAt(a)!;
    t.wood = 5;
    w.intentGather(a.id, "wood");
    w.step();
    const dirty = w.drainDirtyTiles();
    expect(dirty.length).toBe(1);
    expect(dirty[0]).toMatchObject({ q: t.q, r: t.r });
  });

  test("snapshot v2 round-trips structures, items, hidden items and ruins", () => {
    const w = mk();
    const a = w.spawnAgent();
    a.inventory.items.push("key");
    const snap = JSON.parse(JSON.stringify(w.snapshot()));
    const w2 = World.restore(snap);
    expect(w2.tiles).toEqual(w.tiles);
    expect(w2.getAgent(a.id).inventory.items).toEqual(["key"]);
    expect(w2.deadAgents().length).toBe(ANCIENT_RUINS.length);
    expect(w2.tileViews()).toEqual(w.tileViews());
  });
});

describe("no engine-authored social rules, again", () => {
  test("features are data: nothing in features.ts is executed by the engine", async () => {
    const src = await Bun.file(new URL("../../src/world/features.ts", import.meta.url)).text();
    // Only constants and types are exported; no functions the engine could call to adjudicate anything.
    expect(/export (async )?function/.test(src)).toBe(false);
    expect(/export class/.test(src)).toBe(false);
  });
});
