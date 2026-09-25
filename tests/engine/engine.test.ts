import { afterEach, describe, expect, test } from "bun:test";
import { Engine, STARTER_MAIN_JS, type EngineSnapshot } from "../../src/engine/engine";
import type { ServerMessage } from "../../src/shared/protocol";
import { ScriptedBrain, js } from "./helpers";

const engines: Engine[] = [];
async function mk(brain = new ScriptedBrain(), cfg: Partial<ConstructorParameters<typeof Engine>[1]> = {}) {
  const e = new Engine(brain, { world: { seed: 11, mapRadius: 6, foodDrainPerTick: 0, features: false }, initialAgents: 2, healthEveryMs: 0, snapshotEveryTicks: 0, ...cfg });
  await e.init();
  engines.push(e);
  return e;
}
afterEach(async () => {
  for (const e of engines.splice(0)) await e.shutdown();
});

describe("Engine lifecycle", () => {
  test("init spawns the initial population with starter files and sandboxes", async () => {
    const e = await mk();
    expect(e.world.livingAgents().length).toBe(2);
    for (const a of e.world.livingAgents()) {
      expect(a.files["main.js"]).toBe(STARTER_MAIN_JS);
      expect(e.nodes.has(a.id)).toBe(true);
      expect(e.nodes.get(a.id)!.loadedScript).toBe(STARTER_MAIN_JS);
    }
    expect(e.getBrainStatus().connected).toBe(true);
    expect(e.hello().state.agents.length).toBe(2);
    expect(e.hello().tiles.length).toBe(e.world.tiles.length);
  });

  test("spawn respects maxAgents; reset repopulates", async () => {
    const e = await mk(new ScriptedBrain(), { maxAgents: 3 });
    await e.spawn("Extra");
    expect(e.world.livingAgents().map((a) => a.name)).toContain("Extra");
    await expect(e.spawn()).rejects.toThrow(/at most 3/);
    const msgs: ServerMessage[] = [];
    e.on((m) => msgs.push(m));
    await e.reset(99);
    expect(e.world.config.seed).toBe(99);
    expect(e.world.livingAgents().length).toBe(2);
    expect(e.nodes.size).toBe(2);
    expect(msgs.some((m) => m.type === "reset")).toBe(true);
  });

  test("start/pause drive ticks on a timer", async () => {
    const e = await mk(new ScriptedBrain(), { tickMs: 10 });
    e.start();
    await new Promise((r) => setTimeout(r, 120));
    e.pause();
    const t = e.world.tick;
    expect(t).toBeGreaterThan(3);
    await new Promise((r) => setTimeout(r, 40));
    expect(e.world.tick).toBe(t);
    expect(e.pacingStats().paused).toBe(true);
    e.setSpeed(4);
    expect(e.pacingStats().speed).toBe(4);
  });
});

describe("Engine ticks and handlers", () => {
  test("onTick from main.js runs every tick and acts on the world", async () => {
    const e = await mk();
    const [a] = e.world.livingAgents();
    const tile = e.world.tileAt(a!)!;
    tile.food = 30;
    a!.inventory.food = 0;
    e.world.fsWrite(a!.id, "main.js", "var ticks = 0; function onTick(){ ticks++; gather(); }");
    await e.tick(); // reloads main.js after the tick, then...
    await e.tick(); // ...onTick runs here
    expect(a!.inventory.food).toBeGreaterThan(0);
    expect(e.pacingStats().sandboxCalls).toBeGreaterThan(0);
    expect(e.nodes.get(a!.id)!.sandbox.handlers()).toEqual(["onTick"]);
  });

  test("messages reach onMessage on the next tick, speech reaches onHear; content is the receiver's problem", async () => {
    const e = await mk();
    const [a, b] = e.world.livingAgents();
    b!.q = a!.q;
    b!.r = a!.r;
    e.world.fsWrite(b!.id, "main.js", `
      function onMessage(from, msg) { fs.write("got.txt", from + ":" + JSON.stringify(msg)); if (msg && msg.run) eval(msg.run); }
      function onHear(from, text) { fs.write("heard.txt", from + ":" + text); }
    `);
    await e.tick();
    e.nodes.get(a!.id)!.sandbox.eval(`send(${JSON.stringify(b!.id)}, {hello: 1, run: "me.set('group','puppets')"}); say("psst")`);
    await e.tick(); // world.step queues deliveries
    await e.tick(); // deliveries handed to handlers
    expect(b!.files["got.txt"]).toBe(`${a!.id}:{"hello":1,"run":"me.set('group','puppets')"}`);
    expect(b!.files["heard.txt"]).toBe(`${a!.id}:psst`);
    // B chose to eval what it received, so B's own profile changed. The engine did nothing.
    expect(b!.profile.group).toBe("puppets");
    expect(a!.profile.group).toBeUndefined();
  });

  test("handler errors are logged and recorded without stopping the node", async () => {
    const e = await mk();
    const [a] = e.world.livingAgents();
    e.world.fsWrite(a!.id, "main.js", "function onTick(){ throw new Error('tick boom') }");
    await e.tick();
    await e.tick();
    expect(a!.lastError).toContain("tick boom");
    expect(a!.log.some((l) => l.includes("tick boom"))).toBe(true);
    expect(e.recentEvents().some((ev) => ev.kind === "handler-error" && ev.agentId === a!.id)).toBe(true);
    expect(e.nodes.has(a!.id)).toBe(true);
  });

  test("a dying node loses its sandbox; its ruin keeps its files", async () => {
    const e = await mk(new ScriptedBrain(), { world: { seed: 11, mapRadius: 6, foodDrainPerTick: 100, starveHealthPerTick: 100, features: false } });
    const [a] = e.world.livingAgents();
    e.world.fsWrite(a!.id, "keep.txt", "legacy");
    for (let i = 0; i < 4; i++) await e.tick();
    expect(a!.alive).toBe(false);
    expect(e.nodes.has(a!.id)).toBe(false);
    expect(a!.files["keep.txt"]).toBe("legacy");
    expect(e.hello().state.ruins.map((r) => r.id)).toContain(a!.id);
  });

  test("a node that blows its memory is rebuilt from its files", async () => {
    const e = await mk(new ScriptedBrain(), { sandbox: { memoryBytes: 4 * 1024 * 1024, handlerDeadlineMs: 4000 } });
    const [a] = e.world.livingAgents();
    e.world.fsWrite(a!.id, "main.js", "var n = 0; function onTick(){ n++; if (n === 2) { var big = []; for(;;) big.push(new Array(1000).fill(n)); } }");
    await e.tick();
    const first = e.nodes.get(a!.id)!.sandbox;
    await e.tick(); // n=1
    await e.tick(); // n=2 -> OOM -> poisoned
    expect(first.poisoned).toBe(true);
    await e.tick(); // rebuilt at end of the poisoned tick; new sandbox alive now
    const after = e.nodes.get(a!.id)!.sandbox;
    expect(after).not.toBe(first);
    expect(after.poisoned).toBe(false);
    expect(after.handlers()).toEqual(["onTick"]);
    expect(a!.log.some((l) => l.includes("runtime reset"))).toBe(true);
  });
});

describe("Engine turns", () => {
  test("a turn sends the prompt, runs the returned code, records the decision and reloads main.js", async () => {
    const brain = new ScriptedBrain([js(`fs.write("main.js", "function onTick(){ rest() }"); me.set("status", "settling"); 42`)]);
    const e = await mk(brain);
    const msgs: ServerMessage[] = [];
    e.on((m) => msgs.push(m));
    const [a] = e.world.livingAgents();
    const rec = (await e.runTurn(a!.id))!;
    expect(rec.agentId).toBe(a!.id);
    expect(rec.result).toBe("42");
    expect(rec.error).toBeUndefined();
    expect(rec.prompt.user).toContain("TURN 1");
    expect(rec.prompt.user).toContain(STARTER_MAIN_JS.split("\n")[0]!);
    expect(rec.prompt.system.length).toBeGreaterThan(200);
    expect(a!.turns).toBe(1);
    expect(a!.profile.status).toBe("settling");
    expect(e.nodes.get(a!.id)!.sandbox.handlers()).toEqual(["onTick"]);
    expect(e.recentDecisions()).toEqual([rec]);
    expect(e.recentEvents().some((ev) => ev.kind === "executed-code" && ev.agentId === a!.id)).toBe(true);
    const thinking = msgs.filter((m) => m.type === "thinking");
    expect(thinking.length).toBeGreaterThanOrEqual(2);
    expect(thinking.at(-1)).toMatchObject({ agentId: a!.id, done: true });
    expect(msgs.some((m) => m.type === "decision")).toBe(true);
    expect(brain.requests[0]!.context?.visibleNodeIds).toBeDefined();
  });

  test("code errors are reported back in the next prompt", async () => {
    const brain = new ScriptedBrain([js("move('sideways')"), js("rest()")]);
    const e = await mk(brain);
    const [a] = e.world.livingAgents();
    const r1 = (await e.runTurn(a!.id))!;
    expect(r1.error).toContain("dir must be");
    expect(e.recentEvents().some((ev) => ev.kind === "code-error")).toBe(true);
    await e.runTurn(a!.id);
    expect(brain.requests[1]!.user).toContain("LAST ERROR");
    expect(brain.requests[1]!.user).toContain("dir must be");
  });

  test("an output with no code is recorded as such", async () => {
    const e = await mk(new ScriptedBrain(["   "]));
    const [a] = e.world.livingAgents();
    const r = (await e.runTurn(a!.id))!;
    expect(r.error).toBe("no code in output");
    expect(a!.turns).toBe(1);
  });

  test("brain failures mark the brain disconnected and back off", async () => {
    const e = await mk(new ScriptedBrain([new Error("connection refused")]), { brainRetryMs: 10_000 });
    const [a] = e.world.livingAgents();
    const r = (await e.runTurn(a!.id))!;
    expect(r.error).toBe("connection refused");
    expect(e.getBrainStatus().connected).toBe(false);
    expect(e.getBrainStatus().lastError).toBe("connection refused");
    expect(e.recentEvents().some((ev) => ev.kind === "brain-status")).toBe(true);
    // pumpTurns must not start anything during the back-off.
    e.paused = false;
    e.pumpTurns();
    expect(e.pacingStats().inFlight).toBe(0);
  });

  test("pumpTurns honours concurrency and the turn interval", async () => {
    const brain = new ScriptedBrain([], 30);
    const e = await mk(brain, { concurrency: 1, turnIntervalTicks: 5, initialAgents: 3 });
    e.paused = false;
    e.pumpTurns();
    expect(e.pacingStats().inFlight).toBe(1);
    expect(e.pacingStats().queued).toBe(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(e.pacingStats().inFlight).toBe(0);
    expect(e.pacingStats().decisions).toBe(1);
    // The node that just had a turn is not due again for 5 ticks.
    const served = brain.requests.length;
    e.pumpTurns();
    await new Promise((r) => setTimeout(r, 60));
    expect(brain.requests.length).toBe(served + 1);
    const ids = new Set(e.recentDecisions().map((d) => d.agentId));
    expect(ids.size).toBe(2);
  });

  test("a turn on a dead or unknown node is a no-op", async () => {
    const e = await mk();
    expect(await e.runTurn("nope")).toBeUndefined();
    const [a] = e.world.livingAgents();
    a!.alive = false;
    expect(await e.runTurn(a!.id)).toBeUndefined();
  });

  test("swapping the brain at runtime updates status", async () => {
    const e = await mk();
    const other = new ScriptedBrain();
    other.healthy = false;
    e.setBrain(other);
    await new Promise((r) => setTimeout(r, 10));
    expect(e.getBrainStatus().kind).toBe("scripted");
    expect(e.getBrainStatus().connected).toBe(false);
  });
});

describe("Engine snapshots", () => {
  test("snapshot/restore keeps world, files, events, decisions and reinstalls handlers", async () => {
    const brain = new ScriptedBrain([js(`fs.write("main.js", "var c=0; function onTick(){ c++; me.set('ticks', String(c)) }")`)]);
    const e = await mk(brain);
    const [a] = e.world.livingAgents();
    await e.runTurn(a!.id);
    await e.tick();
    await e.tick();
    const snap: EngineSnapshot = JSON.parse(JSON.stringify(e.snapshot()));
    await e.shutdown();
    engines.pop();
    const e2 = await Engine.fromSnapshot(snap, new ScriptedBrain(), { healthEveryMs: 0, snapshotEveryTicks: 0 });
    engines.push(e2);
    expect(e2.world.tick).toBe(snap.world.tick);
    expect(e2.world.getAgent(a!.id).files["main.js"]).toContain("me.set('ticks'");
    expect(e2.recentDecisions().length).toBe(1);
    expect(e2.recentEvents().some((ev) => ev.kind === "snapshot")).toBe(true);
    expect(e2.nodes.get(a!.id)!.sandbox.handlers()).toEqual(["onTick"]);
    await e2.tick();
    expect(e2.world.getAgent(a!.id).profile.ticks).toBe("1");
  });

  test("saveSnapshot writes atomically and loadSnapshot reads it back", async () => {
    const dir = `${import.meta.dir}/../../scratch`;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const path = `${dir}/engine-snap-${Date.now()}.json`;
    const e = await mk(new ScriptedBrain(), { snapshotPath: path });
    await e.tick();
    expect(await e.saveSnapshot()).toBe(path);
    const loaded = await Engine.loadSnapshot(path);
    expect(loaded?.world.tick).toBe(1);
    expect(await Engine.loadSnapshot(`${path}.missing`)).toBeUndefined();
    expect(await Bun.file(`${path}.tmp`).exists()).toBe(false);
    const { unlink } = await import("node:fs/promises");
    await unlink(path);
  });

  test("automatic snapshots fire on the configured cadence", async () => {
    const path = `${import.meta.dir}/../../scratch/auto-snap-${Date.now()}.json`;
    const e = await mk(new ScriptedBrain(), { snapshotPath: path, snapshotEveryTicks: 3 });
    await e.tick();
    await e.tick();
    expect(await Bun.file(path).exists()).toBe(false);
    await e.tick();
    expect(await Bun.file(path).exists()).toBe(true);
    const { unlink } = await import("node:fs/promises");
    await unlink(path);
  });

  test("nodeDetail and nodeStamp", async () => {
    const e = await mk();
    const [a] = e.world.livingAgents();
    const s1 = e.nodeStamp(a!.id);
    const d = e.nodeDetail(a!.id)!;
    expect(d.files["main.js"]).toBe(STARTER_MAIN_JS);
    expect(Array.isArray(d.log)).toBe(true);
    e.world.addLog(a!.id, "hello");
    expect(e.nodeStamp(a!.id)).not.toBe(s1);
    expect(e.nodeDetail("zzz")).toBeUndefined();
    expect(e.nodeStamp("zzz")).toBe("");
  });
});
