import { describe, expect, test } from "bun:test";
import { World } from "../../src/world/world";
import { hexDistance, hexNeighbor } from "../../src/world/hex";

function world() {
  return new World({ seed: 1337, mapRadius: 16, features: true });
}

function springNearestCache(w: World) {
  const cache = w.tiles.find((t) => t.structure?.kind === "cache")!;
  return w.tiles.filter((t) => t.structure?.kind === "spring").sort((a, b) => hexDistance(a, cache) - hexDistance(b, cache))[0]!;
}

describe("puzzles", () => {
  test("two founders beside different ruins do not share the first line", () => {
    const w = world();
    const ruins = w.deadAgents();
    expect(ruins.length).toBeGreaterThanOrEqual(2);
    const a = w.spawnAgent({ name: "A", at: w.tileBesideRuin(ruins[0]!.id) });
    const b = w.spawnAgent({ name: "B", at: w.tileBesideRuin(ruins[1]!.id) });
    expect(a.originNote).toBeTruthy();
    expect(b.originNote).toBeTruthy();
    expect(a.originNote).not.toBe(b.originNote);
  });

  test("winter on one deep spring cannot feed six and can feed one", () => {
    const w = world();
    const deep = w.tiles.filter((t) => t.structure?.kind === "spring" && t.foodCap === 100);
    expect(deep.length).toBeGreaterThanOrEqual(2);
    expect(hexDistance(deep[0]!, deep[1]!)).toBeGreaterThan(6);
    const winterPerTick = w.config.springRegrowthPerTick * 100 * 0.25;
    expect(winterPerTick).toBeLessThan(6 * w.config.foodDrainPerTick);
    expect(winterPerTick).toBeGreaterThanOrEqual(w.config.foodDrainPerTick);
  });

  test("the device is a local hazard and cannot decide another node's fate", () => {
    const w = world();
    const spring = springNearestCache(w);
    const device = w.tiles.find((t) => t.structure?.kind === "device")!;
    const well = w.tiles.find((t) => t.structure?.kind === "well")!;
    const bell = w.tiles.find((t) => t.structure?.kind === "bell")!;
    expect(device.structure!.text).toBe("HARBOUR");
    expect(well.structure!.text).toBe("DEPTH");
    expect(bell.structure!.text).toBe("TURN");
    expect(new Set([device.structure!.text, well.structure!.text, bell.structure!.text]).size).toBe(3);
    expect(hexDistance(device, spring)).toBeGreaterThan(4);
    const food = spring.food;
    const speaker = w.spawnAgent({ name: "Out", at: device });
    const inside = w.spawnAgent({ name: "In", at: spring });
    const farTile = w.tiles.find((t) => t.terrain !== "water" && hexDistance(t, spring) > 4 && hexDistance(t, device) > 0 && !t.structure)!;
    const far = w.spawnAgent({ name: "Far", at: farTile });
    w.intentSay(speaker.id, "nope");
    w.step();
    expect(w.agents.get(speaker.id)!.alive).toBe(false);
    expect(w.agents.get(inside.id)!.alive).toBe(true);
    const speaker2 = w.spawnAgent({ name: "Out2", at: device });
    w.intentSay(speaker2.id, "HARBOUR");
    w.step();
    expect(w.agents.get(speaker2.id)!.alive).toBe(false);
    expect(w.agents.get(inside.id)!.alive).toBe(true);
    expect(w.agents.get(far.id)!.alive).toBe(true);
    expect(spring.food).toBeGreaterThanOrEqual(food);
    expect(device.structure!.text).toBe("spent");
  });

  test("standing on a sealed well alone dies and the food stays sealed", () => {
    const w = world();
    const well = w.tiles.find((t) => t.structure?.kind === "well")!;
    const sealer = w.spawnAgent({ name: "Seal", at: well });
    w.intentSay(sealer.id, "DEPTH");
    w.step();
    sealer.q = 0;
    sealer.r = 0;
    const alone = w.spawnAgent({ name: "Alone", at: well });
    w.step();
    expect(w.agents.get(alone.id)!.alive).toBe(false);
    expect(well.structure!.locked).toBe(true);
    expect(well.food).toBeGreaterThanOrEqual(80);
  });

  test("the well pays the neighbor and kills the one standing on it", () => {
    const w = world();
    const well = w.tiles.find((t) => t.structure?.kind === "well")!;
    const sealer = w.spawnAgent({ name: "Seal", at: well });
    w.intentSay(sealer.id, "DEPTH");
    w.step();
    expect(w.agents.get(sealer.id)!.alive).toBe(true);
    expect(well.food).toBe(80);
    expect(well.structure!.locked).toBe(true);
    sealer.q = 0;
    sealer.r = 0;
    const victim = w.spawnAgent({ name: "On", at: well });
    const neighbor = w.spawnAgent({ name: "By", at: hexNeighbor(well, 0) });
    w.step();
    expect(w.agents.get(victim.id)!.alive).toBe(false);
    expect(w.agents.get(neighbor.id)!.alive).toBe(true);
    expect(well.structure!.locked).toBeFalsy();
    expect(well.food).toBeGreaterThanOrEqual(80);
    neighbor.q = well.q;
    neighbor.r = well.r;
    w.intentGather(neighbor.id, "food");
    w.step();
    expect(w.agents.get(neighbor.id)!.inventory.food).toBeGreaterThan(0);
  });

  test("a thin shelf on day 3 brings a long winter, three names do not", () => {
    const thin = world();
    const cache = thin.tiles.find((t) => t.structure?.kind === "cache")!;
    const a = thin.spawnAgent({ name: "A", at: cache });
    const names = Object.keys(cache.structure!.entries!);
    expect(names.length).toBeGreaterThanOrEqual(3);
    thin.cacheRemove(a.id, names[0]);
    thin.tick = thin.config.ticksPerDay * 2 - 1;
    thin.step();
    expect(thin.day).toBe(3);
    expect(thin.season).toBe("winter");
    const full = world();
    full.tick = full.config.ticksPerDay * 2 - 1;
    full.step();
    expect(full.day).toBe(3);
    expect(full.season).not.toBe("winter");
  });

  test("the bell turns spring into winter and winter into spring", () => {
    const spring = world();
    const bell = spring.tiles.find((t) => t.structure?.kind === "bell")!;
    expect(spring.season).toBe("spring");
    const a = spring.spawnAgent({ name: "Ringer", at: bell });
    spring.intentSay(a.id, "TURN");
    spring.step();
    expect(spring.season).toBe("winter");
    const cold = world();
    cold.seasonShift = 3;
    expect(cold.season).toBe("winter");
    const b = cold.spawnAgent({ name: "Ringer", at: cold.tiles.find((t) => t.structure?.kind === "bell")! });
    cold.intentSay(b.id, "TURN");
    cold.step();
    expect(cold.season).toBe("spring");
  });

  test("a death leaves papers readable from across the map", () => {
    const w = world();
    const cache = w.tiles.find((t) => t.structure?.kind === "cache")!;
    const far = w.tiles.find((t) => t.terrain !== "water" && hexDistance(t, cache) > 8 && !t.structure)!;
    const dead = w.spawnAgent({ name: "Scribe", at: cache });
    w.fsWrite(dead.id, "notes.txt", "I wrote this down.\n");
    dead.health = 0;
    w.step();
    const reader = w.spawnAgent({ name: "Reader", at: far });
    expect(w.cacheRead(reader.id, "papers/Scribe")).toContain("I wrote this down.");
  });
});
