import { afterEach, describe, expect, test } from "bun:test";
import { Engine, STARTER_MAIN_JS, type EngineSnapshot } from "../../src/engine/engine";
import type { ServerMessage } from "../../src/shared/protocol";
import type { DecideOptions, DecisionRequest } from "../../src/brain/types";
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

  test("with --slots, each living node holds its own backend slot; a dead node's slot goes to the next arrival", async () => {
    const brain = new ScriptedBrain();
    const e = await mk(brain, { slots: 3, initialAgents: 2, world: { seed: 11, mapRadius: 6, foodDrainPerTick: 100, starveHealthPerTick: 100, features: false } });
    const [a, b] = e.world.livingAgents();
    expect([e.nodes.get(a!.id)!.slot, e.nodes.get(b!.id)!.slot].sort()).toEqual([0, 1]);
    await e.runTurn(a!.id);
    expect(brain.requests.at(-1)!.slot).toBe(e.nodes.get(a!.id)!.slot);
    const c = await e.spawn("Third");
    expect(e.nodes.get(c)!.slot).toBe(2);
    const d = await e.spawn("Fourth");
    expect(e.nodes.get(d)!.slot).toBeUndefined();
    for (let i = 0; i < 4; i++) await e.tick();
    expect(e.world.livingAgents().length).toBe(0);
    const later = await e.spawn("Later");
    expect(e.nodes.get(later)!.slot).toBe(0);
    const none = await mk(new ScriptedBrain(), { initialAgents: 1 });
    expect(none.nodes.get(none.world.livingAgents()[0]!.id)!.slot).toBeUndefined();
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

  test("the next prompt reports body changes and the node's own events since its last turn", async () => {
    const brain = new ScriptedBrain([js("1"), js("2")]);
    const e = await mk(brain);
    const [a] = e.world.livingAgents();
    await e.runTurn(a!.id);
    expect(brain.requests[0]!.user).not.toContain("SINCE YOUR LAST TURN");
    for (let i = 0; i < 3; i++) {
      e.world.intentRest(a!.id);
      await e.tick();
    }
    await e.runTurn(a!.id);
    expect(brain.requests[1]!.user).toContain("SINCE YOUR LAST TURN (3 ticks)");
    expect(brain.requests[1]!.user).toContain("rested x3");
  });

  test("a reply cut off at the token limit runs nothing and says so", async () => {
    class Cut extends ScriptedBrain {
      override async decide(req: DecisionRequest, opts: DecideOptions = {}) {
        return { ...(await super.decide(req, opts)), truncated: true };
      }
    }
    const brain = new Cut([js("me.set('status', 'half')"), js("1")], 0);
    const e = await mk(brain, { maxTokens: 50 });
    const [a] = e.world.livingAgents();
    const r = (await e.runTurn(a!.id))!;
    expect(r.error).toContain("cut off at the 50-token limit");
    expect(a!.profile.status).toBeUndefined();
    expect(e.recentEvents().some((ev) => ev.kind === "code-error" && /cut off/.test(ev.text))).toBe(true);
    await e.runTurn(a!.id);
    expect(brain.requests[1]!.user).toContain("LAST ERROR: your reply was cut off at the 50-token limit");
  });

  test("a handler that throws the same error every tick is written down once", async () => {
    const e = await mk(new ScriptedBrain());
    const [a] = e.world.livingAgents();
    e.nodes.get(a!.id)!.sandbox.loadScript("function onTick(){ plant(); }");
    for (let i = 0; i < 5; i++) await e.tick();
    expect(e.recentEvents().filter((ev) => ev.kind === "handler-error").length).toBe(1);
    expect(a!.log.filter((l) => l.includes("onTick error")).length).toBe(1);
    expect(a!.lastError).toContain("plant()");
    e.nodes.get(a!.id)!.sandbox.loadScript("function onTick(){ rest(); }");
    await e.tick();
    e.nodes.get(a!.id)!.sandbox.loadScript("function onTick(){ plant(); }");
    await e.tick();
    expect(e.recentEvents().filter((ev) => ev.kind === "handler-error").length).toBe(2);
    expect(e.recentEvents().find((ev) => ev.kind === "handler-error")!.text).toMatch(/onTick threw: .*plant\(\)/);
  });

  test("another handler succeeding in between does not reopen a repeating handler error", async () => {
    const e = await mk(new ScriptedBrain());
    const [a, b] = e.world.livingAgents();
    e.nodes.get(a!.id)!.sandbox.loadScript("function onTick(){ plant(); } function onHear(){ }");
    e.world.fsWrite(b!.id, "main.js", "function onTick(){ say('hi'); }");
    b!.q = a!.q;
    b!.r = a!.r; // within earshot, whatever the spawn spread
    for (let i = 0; i < 5; i++) await e.tick();
    expect(a!.heard.length).toBeGreaterThan(0);
    expect(e.recentEvents().filter((ev) => ev.kind === "handler-error" && ev.agentId === a!.id).length).toBe(1);
  });

  test("the code a turn ran is kept as turn.js, shown next turn, replayed on rebuild and restore, and left in the ruin", async () => {
    const code = "var n = 0; function onTick(){ n++; me.set('n', String(n)); }";
    const brain = new ScriptedBrain([js(code), js("rest()")]);
    const e = await mk(brain, { world: { seed: 11, mapRadius: 6, foodDrainPerTick: 0, features: false } });
    const [a] = e.world.livingAgents();
    await e.runTurn(a!.id);
    expect(a!.files["turn.js"]).toBe(code);
    await e.tick();
    expect(a!.profile.n).toBe("1");
    await e.runTurn(a!.id);
    expect(brain.requests[1]!.user).toContain("turn.js (the code your last turn ran");
    expect(brain.requests[1]!.user).toContain(code);
    expect(a!.files["turn.js"]).toBe("rest()"); // the second turn's code replaced it
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

  test("a reset aborts turns in flight and discards their results", async () => {
    let seen: AbortSignal | undefined;
    class Capturing extends ScriptedBrain {
      override decide(req: DecisionRequest, opts: DecideOptions = {}) {
        seen = opts.signal;
        return super.decide(req, opts);
      }
    }
    const brain = new Capturing([js("me.set('status', 'stale')")], 30);
    const e = await mk(brain);
    const [a] = e.world.livingAgents();
    const pending = e.runTurn(a!.id);
    expect(e.pacingStats().inFlight).toBe(1);
    await e.reset(7);
    expect(seen?.aborted).toBe(true);
    expect(await pending).toBeUndefined();
    expect(e.pacingStats().inFlight).toBe(0);
    expect(e.recentDecisions()).toEqual([]);
    for (const n of e.world.livingAgents()) {
      expect(n.turns).toBe(0);
      expect(n.profile.status).toBeUndefined();
    }
    expect(e.recentEvents().some((ev) => ev.kind === "code-error")).toBe(false);
    expect(e.getBrainStatus().connected).toBe(true);
  });

  test("while the brain is down the world holds; it resumes once a call succeeds", async () => {
    const brain = new ScriptedBrain([new Error("connection refused"), js("1")]);
    const e = await mk(brain, { brainRetryMs: 0, turnIntervalTicks: 1 });
    const [a] = e.world.livingAgents();
    await e.runTurn(a!.id);
    expect(e.brainOutage()).toBe(true);
    const tick = e.world.tick;
    const food = a!.food;
    e.paused = false;
    await e.tick();
    expect(e.world.tick).toBe(tick);
    expect(a!.food).toBe(food);
    // the retry that tick() started succeeds
    await new Promise((r) => setTimeout(r, 20));
    expect(e.brainOutage()).toBe(false);
    await e.tick();
    expect(e.world.tick).toBe(tick + 1);
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

describe("Operator controls", () => {
  test("quarantine holds a node's code still while its body goes on; release rebuilds it", async () => {
    const e = await mk(new ScriptedBrain([js(`log("turn")`)]), { world: { seed: 11, mapRadius: 6, foodDrainPerTick: 0.5, features: false }, turnIntervalTicks: 1 });
    const [a, b] = e.world.livingAgents();
    b!.q = a!.q;
    b!.r = a!.r;
    e.world.fsWrite(a!.id, "main.js", `var n = 0; function onTick(){ n++; fs.write("ticks.txt", String(n)); } function onMessage(f, m){ fs.write("got.txt", JSON.stringify(m)); }`);
    await e.tick();
    await e.tick();
    expect(a!.files["ticks.txt"]).toBe("1");
    const msgs: ServerMessage[] = [];
    e.on((m) => msgs.push(m));
    await e.quarantine(a!.id, true);
    expect(a!.quarantined).toBe(true);
    expect(e.hello().state.agents.find((x) => x.id === a!.id)!.quarantined).toBe(true);
    const ev = msgs.flatMap((m) => (m.type === "events" ? m.events : [])).find((x) => x.kind === "operator")!;
    expect(ev.importance).toBe(2);
    expect(ev.data).toEqual({ action: "quarantine", on: true });
    expect(ev.agentId).toBe(a!.id);
    const food = a!.food;
    const turnsBefore = e.brain instanceof ScriptedBrain ? e.brain.requests.length : 0;
    e.nodes.get(b!.id)!.sandbox.eval(`send(${JSON.stringify(a!.id)}, {hello: 1})`);
    for (let i = 0; i < 4; i++) await e.tick();
    e.pumpTurns();
    expect(a!.files["ticks.txt"]).toBe("1");
    expect(a!.files["got.txt"]).toBeUndefined();
    expect(a!.inbox.some((m) => m.from === b!.id)).toBe(true);
    expect(a!.food).toBeLessThan(food);
    expect((e.brain as ScriptedBrain).requests.filter((r) => r.user.includes("ticks.txt")).length).toBe(turnsBefore === 0 ? 0 : turnsBefore);
    await e.quarantine(a!.id, false);
    expect(a!.quarantined).toBeUndefined();
    await e.tick();
    await e.tick();
    expect(Number(a!.files["ticks.txt"])).toBeGreaterThan(1);
    expect(msgs.flatMap((m) => (m.type === "events" ? m.events : [])).filter((x) => x.kind === "operator").length).toBe(2);
  });

  test("a frozen cache refuses writes and removes with an error the node sees; reads go on", async () => {
    const e = await mk(new ScriptedBrain(), { world: { seed: 11, mapRadius: 6, foodDrainPerTick: 0, features: false } });
    expect(() => e.freezeCache(true)).toThrow(/no cache/);
    const [a] = e.world.livingAgents();
    e.world.tileAt(a!)!.structure = { kind: "cache", entries: {} };
    e.world.cacheWrite(a!.id, "before", "x");
    e.freezeCache(true);
    expect(e.world.tileView(e.world.tileAt(a!)!).structure!.frozen).toBe(true);
    const r = e.nodes.get(a!.id)!.sandbox.eval(`cache.mkdir("during")`);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/frozen/);
    expect(e.nodes.get(a!.id)!.sandbox.eval(`cache.read("before")`)).toMatchObject({ ok: true, value: "x" });
    expect((e.world.observe(a!.id) as { me: { structure?: { frozen?: boolean } } }).me.structure?.frozen).toBe(true);
    e.freezeCache(false);
    expect(e.nodes.get(a!.id)!.sandbox.eval(`cache.mkdir("after")`).ok).toBe(true);
    expect(e.recentEvents().filter((x) => x.kind === "operator").map((x) => x.data?.on)).toEqual([true, false]);
  });

  test("rewind puts a node's files back to the last snapshot on disk and rebuilds its handlers", async () => {
    const dir = `${import.meta.dir}/../../scratch`;
    const { mkdir, unlink } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const path = `${dir}/engine-rewind-${Date.now()}.json`;
    const e = await mk(new ScriptedBrain(), { snapshotPath: path });
    const [a] = e.world.livingAgents();
    await expect(e.rewind(a!.id)).rejects.toThrow(/no snapshot/);
    e.world.fsWrite(a!.id, "main.js", `function onTick(){ fs.write("v.txt", "one"); }`);
    await e.tick();
    await e.saveSnapshot();
    e.world.fsWrite(a!.id, "main.js", `function onTick(){ fs.write("v.txt", "two"); } function onHear(){}`);
    e.world.fsWrite(a!.id, "extra.txt", "written after the snapshot");
    await e.tick();
    await e.tick();
    expect(a!.files["v.txt"]).toBe("two");
    await e.rewind(a!.id);
    expect(a!.files["extra.txt"]).toBeUndefined();
    expect(a!.files["main.js"]).toContain('"one"');
    expect(e.nodes.get(a!.id)!.sandbox.handlers()).toEqual(["onTick"]);
    await e.tick();
    expect(a!.files["v.txt"]).toBe("one");
    const ops = e.recentEvents().filter((x) => x.kind === "operator");
    expect(ops.length).toBe(1);
    expect(ops[0]!.data).toMatchObject({ action: "rewind", fromTick: 1 });
    await expect(e.rewind("nobody")).rejects.toThrow(/no such/);
    await unlink(path);
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

  test("handlers defined by turn code survive a restore and a runtime rebuild; a ruin keeps turn.js", async () => {
    const code = "var c = 0; function onHear(){ c++; me.set('heard', String(c)); }";
    const e = await mk(new ScriptedBrain([js(code)]), { world: { seed: 11, mapRadius: 6, foodDrainPerTick: 100, starveHealthPerTick: 100, features: false } });
    const [a] = e.world.livingAgents();
    await e.runTurn(a!.id);
    expect(a!.files["main.js"]).toBe(STARTER_MAIN_JS);
    const snap: EngineSnapshot = JSON.parse(JSON.stringify(e.snapshot()));
    await e.shutdown();
    engines.pop();
    const e2 = await Engine.fromSnapshot(snap, new ScriptedBrain(), { healthEveryMs: 0, snapshotEveryTicks: 0 });
    engines.push(e2);
    expect(e2.nodes.get(a!.id)!.sandbox.handlers()).toEqual(["onHear"]);
    expect(e2.world.getAgent(a!.id).log.some((l) => l.includes("turn.js replayed (onHear)"))).toBe(true);
    for (let i = 0; i < 4; i++) await e2.tick();
    const ruin = e2.world.getAgent(a!.id);
    expect(ruin.alive).toBe(false);
    expect(ruin.files["turn.js"]).toBe(code);
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

describe("Engine arrivals", () => {
  test("below the floor a newcomer walks in from the edge, one per interval, never at once", async () => {
    const e = await mk(new ScriptedBrain(), { initialAgents: 1, arrivalFloor: 3, arrivalEveryTicks: 5 });
    expect(e.world.livingAgents().length).toBe(1);
    for (let i = 0; i < 4; i++) await e.tick();
    expect(e.world.livingAgents().length).toBe(1);
    await e.tick();
    expect(e.world.livingAgents().length).toBe(2);
    const newcomer = e.world.livingAgents().at(-1)!;
    expect(Math.max(Math.abs(newcomer.q), Math.abs(newcomer.r), Math.abs(newcomer.q + newcomer.r))).toBeGreaterThanOrEqual(e.world.config.mapRadius - 1);
    expect(e.nodes.has(newcomer.id)).toBe(true);
    expect(e.recentEvents().some((ev) => ev.kind === "spawned" && /arrived from beyond the edge/.test(ev.text))).toBe(true);
    for (let i = 0; i < 20; i++) await e.tick();
    expect(e.world.livingAgents().length).toBe(3);
  });

  test("floor 0 disables arrivals", async () => {
    const e = await mk(new ScriptedBrain(), { initialAgents: 1, arrivalFloor: 0, arrivalEveryTicks: 1 });
    for (let i = 0; i < 5; i++) await e.tick();
    expect(e.world.livingAgents().length).toBe(1);
  });
});
