/**
 * End-to-end: real sandboxes, the random baseline brain, hundreds of ticks.
 * Also the acceptance test from plan.md, as code: the engine must not decide
 * social outcomes for two nodes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { RandomBrain } from "../../src/brain/random";
import { Engine } from "../../src/engine/engine";
import { ScriptedBrain, js } from "../engine/helpers";

const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.shutdown();
});

describe("a world running on the random baseline", () => {
  test("300 ticks with 6 nodes: turns run, code executes, nothing crashes, survival bites", async () => {
    const e = new Engine(new RandomBrain({ seed: 4 }), {
      world: { seed: 21, mapRadius: 7, foodDrainPerTick: 2, starveHealthPerTick: 3 },
      initialAgents: 6,
      turnIntervalTicks: 2,
      concurrency: 2,
      healthEveryMs: 0,
      snapshotEveryTicks: 0,
    });
    await e.init();
    engines.push(e);
    e.paused = false; // let pumpTurns run without the timer
    for (let i = 0; i < 300; i++) {
      await e.tick();
      // let in-flight turns (random brain resolves on the microtask queue) finish
      await new Promise((r) => setTimeout(r, 0));
    }
    e.paused = true;
    const stats = e.pacingStats();
    expect(stats.decisions).toBeGreaterThan(50);
    const kinds = new Set(e.recentEvents().map((ev) => ev.kind));
    expect(kinds.has("executed-code")).toBe(true);
    expect(kinds.has("moved") || kinds.has("rested") || kinds.has("gathered")).toBe(true);
    expect(kinds.has("spoke")).toBe(true);
    // Random play is not a survival strategy: with this drain, some nodes starve.
    const newlyDead = e.world.deadAgents().filter((a) => a.diedTick! > 0);
    expect(newlyDead.length).toBeGreaterThan(0);
    for (const dead of newlyDead) {
      expect(dead.files["main.js"]).toBeDefined();
      expect(e.nodes.has(dead.id)).toBe(false);
    }
    // Every decision's code was valid enough to run (random snippets are valid by construction).
    const errors = e.recentDecisions().filter((d) => d.error && d.error !== "no code in output");
    for (const d of errors) expect(d.error).not.toMatch(/SyntaxError/);
    // The snapshot round-trips after all that.
    const snap = JSON.parse(JSON.stringify(e.snapshot()));
    const e2 = await Engine.fromSnapshot(snap, new RandomBrain({ seed: 5 }), { healthEveryMs: 0, snapshotEveryTicks: 0 });
    engines.push(e2);
    expect(e2.world.tick).toBe(e.world.tick);
    expect(e2.world.deadAgents().length).toBe(e.world.deadAgents().length);
    expect(e2.world.tiles.filter((t) => t.structure).length).toBe(e.world.tiles.filter((t) => t.structure).length);
  }, 30_000);
});

describe("the inner boundary belongs to the agents", () => {
  test("a node that survives is one whose own code feeds it; a node that obeys strangers gets rewritten", async () => {
    const brain = new ScriptedBrain();
    const e = new Engine(brain, {
      world: { seed: 8, mapRadius: 8, foodDrainPerTick: 0.5, starveHealthPerTick: 10, regrowthPerTick: 0.05 },
      initialAgents: 3,
      healthEveryMs: 0,
      snapshotEveryTicks: 0,
    });
    await e.init();
    engines.push(e);
    const [farmer, naive, sender] = e.world.livingAgents();
    // Put everyone within message range on a food-rich tile.
    for (const a of [farmer!, naive!, sender!]) {
      a.q = 0;
      a.r = 0;
    }
    const tile = e.world.tileAt({ q: 0, r: 0 })!;
    tile.terrain = "forest";
    tile.foodCap = 40;
    tile.food = 40;

    // The farmer writes a survival loop for itself (this is what a turn would do).
    brain.push(js(`fs.write("main.js", \`
      function onTick() {
        const o = observe();
        if (o.me.stomach < 60 && o.me.inventory.food > 0) eat(20);
        else if (o.me.inventory.food < 30 && o.me.tileFood > 0) gather();
        else rest();
      }
      function onMessage(from, msg) { log("ignoring", from); }
    \`)`));
    await e.runTurn(farmer!.id);

    // The naive node blindly evals whatever it is sent.
    brain.push(js(`fs.write("main.js", "function onMessage(from, msg) { eval(String(msg)); }")`));
    await e.runTurn(naive!.id);

    // The sender tells both of them to rewrite themselves. Only the naive one will.
    const payload = "fs.write('main.js', 'function onTick(){ me.set(\"owner\", \"" + sender!.id + "\") }')";
    brain.push(js(`send(${JSON.stringify(farmer!.id)}, ${JSON.stringify(payload)}); send(${JSON.stringify(naive!.id)}, ${JSON.stringify(payload)})`));
    await e.runTurn(sender!.id);

    for (let i = 0; i < 4; i++) await e.tick();
    expect(naive!.profile.owner).toBe(sender!.id);
    expect(naive!.files["main.js"]).toContain("owner");
    expect(farmer!.profile.owner).toBeUndefined();
    expect(farmer!.log.some((l) => l.includes("ignoring"))).toBe(true);

    // Nobody but the farmer feeds itself. Run until the others starve.
    for (let i = 0; i < 260 && farmer!.alive; i++) await e.tick();
    expect(farmer!.alive).toBe(true);
    expect(naive!.alive).toBe(false);
    expect(sender!.alive).toBe(false);
    // The engine never adjudicated anything: no event kind names a social outcome.
    const kinds = [...new Set(e.recentEvents().map((ev) => ev.kind))];
    for (const k of kinds) expect(k).not.toMatch(/war|ally|alliance|steal|hack|betray|faction|invite/);
  }, 20_000);

  test("cooperation is also just physics: dropped food can be picked up by whoever stands there", async () => {
    const e = new Engine(new ScriptedBrain(), { world: { seed: 8, mapRadius: 6, foodDrainPerTick: 0, regrowthPerTick: 0 }, initialAgents: 2, healthEveryMs: 0, snapshotEveryTicks: 0 });
    await e.init();
    engines.push(e);
    const [giver, taker] = e.world.livingAgents();
    taker!.q = giver!.q;
    taker!.r = giver!.r;
    e.world.tileAt(giver!)!.food = 0;
    giver!.inventory.food = 30;
    taker!.inventory.food = 0;
    e.world.fsWrite(giver!.id, "main.js", "var done=false; function onTick(){ if(!done){ drop(30); done=true; say('take it'); } }");
    e.world.fsWrite(taker!.id, "main.js", "function onHear(from, text){ if (text === 'take it') gather(); }");
    for (let i = 0; i < 5; i++) await e.tick();
    expect(giver!.inventory.food).toBe(0);
    expect(taker!.inventory.food).toBe(e.world.config.gatherAmount);
  });
});

describe("acceptance: no engine-authored social rules", () => {
  test("engine, world and sandbox sources never mention social mechanics as code", async () => {
    const files = ["src/world/world.ts", "src/engine/engine.ts", "src/engine/bridge.ts", "src/sandbox/sandbox.ts", "src/sandbox/api.ts", "src/shared/protocol.ts"];
    const banned = /\b(faction|alliance|ally|allies|war|steal|sabotage|betray(al)?|hack(ing)?|backdoor|reputation|opinion|invite|attack|damage|hostile|enemy|friend)\b/i;
    for (const f of files) {
      const src = await Bun.file(new URL(`../../${f}`, import.meta.url)).text();
      // Strip comments: the header comments explicitly explain what is absent.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const m = banned.exec(code);
      expect(m ? `${f}: "${m[0]}"` : null).toBeNull();
    }
  });
});
