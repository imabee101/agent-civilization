import { afterEach, describe, expect, test } from "bun:test";
import { Engine, STARTER_MAIN_JS, type EngineSnapshot } from "../../src/engine/engine";
import type { ServerMessage } from "../../src/shared/protocol";
import type { BackendProfile, DecideOptions, DecisionRequest } from "../../src/brain/types";
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

  test("a reply cut off at the token limit runs only the complete lines before the cut, and says so", async () => {
    class Cut extends ScriptedBrain {
      override async decide(req: DecisionRequest, opts: DecideOptions = {}) {
        return { ...(await super.decide(req, opts)), truncated: true };
      }
    }
    // Two complete statements, then a handler cut mid-body.
    const brain = new Cut(["```js\nme.set('status', 'half');\nfs.write('a.txt', 'x');\nfunction onHear(from, text) {\n  if (text.includes('hi')) {\n    say(`hello ", "```js\nfunction onTick() {\n  if (me.energy < 20"], 0);
    const e = await mk(brain, { maxTokens: 50 });
    const [a] = e.world.livingAgents();
    const r = (await e.runTurn(a!.id))!;
    expect(r.error).toContain("cut off at the 50-token limit");
    expect(r.error).toContain("only the first 2 of 5 lines were complete and ran");
    expect(a!.profile.status).toBe("half");
    expect(a!.files["a.txt"]).toBe("x");
    expect(e.nodes.get(a!.id)!.sandbox.handlers()).toEqual([]);
    expect(a!.files["turn.js"]).toBe("me.set('status', 'half');\nfs.write('a.txt', 'x');");
    const evs = e.recentEvents();
    expect(evs.some((ev) => ev.kind === "code-error" && /cut off/.test(ev.text))).toBe(true);
    expect(evs.some((ev) => ev.kind === "executed-code" && ev.data?.partial === true)).toBe(true);
    // Nothing complete before the cut: nothing runs.
    const r2 = (await e.runTurn(a!.id))!;
    expect(brain.requests[1]!.user).toContain("LAST ERROR: your reply was cut off at the 50-token limit; only the first 2 of 5 lines");
    expect(r2.error).toContain("no complete line could run");
    expect(r2.result).toBeUndefined();
    await e.runTurn(a!.id);
    expect(brain.requests[2]!.user).toContain("LAST ERROR: your reply was cut off at the 50-token limit, so none of it ran");
  });

  test("top-level const and let persist between turns and may be declared again; main.js and turn.js get the same treatment", async () => {
    const brain = new ScriptedBrain([js("const stone = 1; let n = 2; me.set('a', stone + n)"), js("const stone = 10; let n = 20; me.set('a', stone + n)")], 0);
    const e = await mk(brain);
    const [a] = e.world.livingAgents();
    expect((await e.runTurn(a!.id))!.error).toBeUndefined();
    expect(a!.profile.a).toBe("3");
    expect((await e.runTurn(a!.id))!.error).toBeUndefined();
    expect(a!.profile.a).toBe("30");
    // A const at column 0 in main.js reloads cleanly after a change, and turn.js replays over it after a rebuild.
    e.world.fsWrite(a!.id, "main.js", "const base = 5;\nfunction onTick() { me.set('b', base) }");
    await e.tick();
    await e.tick();
    expect(a!.profile.b).toBe("5");
    e.world.fsWrite(a!.id, "main.js", "const base = 6;\nfunction onTick() { me.set('b', base) }");
    await e.tick();
    await e.tick();
    expect(a!.profile.b).toBe("6");
    expect(a!.lastError).toBeUndefined();
  });

  test("the prompt tells the node its reply budget and shrinks to the character budget", async () => {
    const brain = new ScriptedBrain([], 0);
    const e = await mk(brain, { maxTokens: 240, promptMaxChars: 3000 });
    const [a] = e.world.livingAgents();
    for (let i = 0; i < 40; i++) e.world.addLog(a!.id, `line ${i} ${"x".repeat(60)}`);
    await e.runTurn(a!.id);
    const u = brain.requests[0]!.user;
    expect(u).toContain("REPLY BUDGET: 240 tokens, about 20 short lines.");
    expect(u.length).toBeLessThanOrEqual(3000 + 400);
    expect(u).not.toContain("line 0 ");
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
    const e = await mk(new ScriptedBrain([new Error("connection refused")]), { brainRetryMs: 10_000, brainRetries: 0 });
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

  test("while the brain is down the world holds and no turn is dispatched; a health probe brings it back", async () => {
    const brain = new ScriptedBrain([new Error("connection refused"), js("1")]);
    const e = await mk(brain, { brainRetryMs: 0, brainRetries: 0, turnIntervalTicks: 1 });
    const [a] = e.world.livingAgents();
    await e.runTurn(a!.id);
    expect(e.brainOutage()).toBe(true);
    brain.healthy = false;
    const tick = e.world.tick;
    const food = a!.food;
    const asked = brain.requests.length;
    e.paused = false;
    await e.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(e.world.tick).toBe(tick);
    expect(a!.food).toBe(food);
    expect(brain.requests.length).toBe(asked); // no node spent a turn on a brain that is down
    expect(e.brainOutage()).toBe(true);
    brain.healthy = true;
    await e.tick(); // the probe this tick starts finds it back
    await new Promise((r) => setTimeout(r, 20));
    expect(e.brainOutage()).toBe(false);
    expect(e.recentEvents().some((ev) => ev.kind === "brain-status" && /^Brain back after \d+ s$/.test(ev.text))).toBe(true);
    await e.tick();
    expect(e.world.tick).toBe(tick + 1);
  });

  test("a failed call is tried again on the same facts; the node's events wait for a turn that answers", async () => {
    const brain = new ScriptedBrain([js("say('hi')"), new Error("socket closed"), new Error("socket closed"), js("2")]);
    const e = await mk(brain, { brainRetryMs: 0, brainRetries: 1, world: { seed: 11, mapRadius: 6, foodDrainPerTick: 0, features: false, hearRadius: 0 } });
    const [a] = e.world.livingAgents();
    await e.runTurn(a!.id);
    await e.tick(); // say() resolves: a "spoke" event lands in the node's tally
    expect(e.world.peekTally(a!.id).spoke).toBe(1);
    // Two failures in a row: the retry fails too, the turn is given up, and the tally is untouched.
    const failed = (await e.runTurn(a!.id))!;
    expect(failed.error).toBe("socket closed");
    expect(a!.log.some((l) => /brain error: socket closed; trying again/.test(l))).toBe(true);
    expect(e.world.peekTally(a!.id).spoke).toBe(1);
    expect(e.recentDecisions().filter((d) => d.error).length).toBe(1); // one record for the two attempts
    // Retry now succeeds: the prompt still carries the events from before the failed call.
    await e.checkBrain(); // the probe finds it healthy again
    brain.push(new Error("socket closed"), js("3"));
    const ok = (await e.runTurn(a!.id))!;
    expect(ok.error).toBeUndefined();
    expect(brain.requests.at(-1)!.user).toContain("spoke x1");
    expect(e.world.peekTally(a!.id).spoke).toBeUndefined();
  });

  test("a tick message carries ruins only when their set changed; hello and decisions carry the system prompt once", async () => {
    const quiet = await mk(new ScriptedBrain());
    const quietMsgs: ServerMessage[] = [];
    quiet.on((m) => quietMsgs.push(m));
    quiet.paused = false;
    await quiet.tick();
    const lastQuiet = quietMsgs.filter((m): m is Extract<ServerMessage, { type: "tick" }> => m.type === "tick").at(-1)!;
    expect(lastQuiet.state.ruins).toBeUndefined(); // nothing changed since init's first message
    expect(lastQuiet.state.agents.length).toBe(2);
    const e = await mk(new ScriptedBrain([js("rest()")]), { initialAgents: 1, world: { seed: 11, mapRadius: 6, foodDrainPerTick: 100, starveHealthPerTick: 100, features: false } });
    const msgs: ServerMessage[] = [];
    e.on((m) => msgs.push(m));
    const ticks = () => msgs.filter((m): m is Extract<ServerMessage, { type: "tick" }> => m.type === "tick");
    e.paused = false;
    for (let i = 0; i < 3; i++) await e.tick();
    expect(e.world.deadAgents().length).toBe(1);
    const withRuins = ticks().filter((t) => t.state.ruins);
    expect(withRuins.length).toBe(1); // the tick on which the node died, and no tick after it
    expect(withRuins[0]!.state.ruins!.map((r) => r.id)).toEqual(e.world.deadAgents().map((a) => a.id));
    expect(ticks().at(-1)!.state.ruins).toBeUndefined();
    const h = e.hello();
    expect(h.systemPrompt.length).toBeGreaterThan(1000);
    expect(JSON.stringify(h).split(JSON.stringify(h.systemPrompt).slice(1, 80)).length - 1).toBe(1); // the prompt is in there once
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

  test("a turn asks the brain to stop at the closing fence, and keeps the backend's timings", async () => {
    class Timed extends ScriptedBrain {
      override async decide(req: DecisionRequest, opts?: DecideOptions) {
        return { ...(await super.decide(req, opts)), tokens: 300, latencyMs: 20_000, timings: { promptTokens: 2000, cachedTokens: 1300, promptMs: 7000, outputTokens: 300, outputMs: 13_000 } };
      }
    }
    const brain = new Timed([js("rest()")]);
    const e = await mk(brain);
    const id = e.world.livingAgents()[0]!.id;
    const d = (await e.runTurn(id))!;
    expect(brain.requests[0]!.stop).toEqual(["\n```"]);
    expect(d.timings).toEqual({ promptTokens: 2000, cachedTokens: 1300, promptMs: 7000, outputTokens: 300, outputMs: 13_000 });
    const p = e.pacingStats();
    expect(p.prefillTps).toBe(100);
    expect(p.decodeTps).toBeCloseTo(23.1, 1);
    expect(p.cacheHit).toBe(0.65);
  });

  test("the brain is measured once it answers; what the measurement says sets what nobody set by hand", async () => {
    class Probed extends ScriptedBrain {
      probes = 0;
      async probe(): Promise<BackendProfile> {
        this.probes++;
        return { kind: "bandwidth-bound" as const, prefillTps: 110, decodeTps: 17, slots: 12, ctxPerSlot: 6144, cacheable: true, probedAt: 1 };
      }
    }
    const brain = new Probed();
    const e = await mk(brain, { concurrency: 3, maxTokens: 600 });
    expect(brain.probes).toBe(1); // init's health check probed
    expect(e.getBrainStatus().profile?.kind).toBe("bandwidth-bound");
    expect(e.cfg.slots).toBe(12);
    // 6144 ctx - 600 reply - 256 margin = 5288 tokens x 3.5 chars, minus the system prompt.
    expect(e.cfg.promptMaxChars).toBe(Math.floor(5288 * 3.5) - (await import("../../src/brain/prompt")).SYSTEM_PROMPT.length);
    expect(e.pacingStats().concurrency).toBe(1); // governed: one at a time until the next level measures better
    expect(e.pacingStats().governed).toBe(true);
    for (const rt of e.nodes.values()) expect(rt.slot).toBeDefined();
    expect(e.recentEvents().some((ev) => ev.kind === "brain-status" && /Brain measured: bandwidth-bound, 110 prompt tokens\/s, 17 output tokens\/s, 12 slots of 6144 tokens; running 1 turn/.test(ev.text))).toBe(true);
    await e.checkBrain();
    expect(brain.probes).toBe(1); // measured once
    // Given by hand: the measurement does not override.
    const given = await mk(new Probed(), { concurrency: 3, slots: 2, promptMaxChars: 4000 });
    expect(given.cfg.slots).toBe(2);
    expect(given.cfg.promptMaxChars).toBe(4000);
    // A fast backend is not governed: the ceiling from the first turn.
    class Fast extends Probed {
      override async probe() {
        return { ...(await super.probe()), kind: "fast" as const, prefillTps: 1800, decodeTps: 70 };
      }
    }
    const fast = await mk(new Fast(), { concurrency: 3 });
    expect(fast.pacingStats()).toMatchObject({ concurrency: 3, governed: false });
  });

  test("real timings reclassify the backend when it turns out faster or slower than the probe said", async () => {
    class Reclassified extends ScriptedBrain {
      async probe(): Promise<BackendProfile> {
        return { kind: "bandwidth-bound" as const, prefillTps: 100, decodeTps: 17, cacheable: true, probedAt: 1 };
      }
      override async decide(req: DecisionRequest, opts?: DecideOptions) {
        return { ...(await super.decide(req, opts)), tokens: 300, latencyMs: 5000, timings: { promptTokens: 2000, cachedTokens: 0, promptMs: 1000, outputTokens: 300, outputMs: 4000 } };
      }
    }
    const e = await mk(new Reclassified([js("rest()")]), { concurrency: 3 });
    expect(e.pacingStats().governed).toBe(true);
    await e.runTurn(e.world.livingAgents()[0]!.id);
    expect(e.getBrainStatus().profile?.kind).toBe("fast"); // 2000 prompt tok/s, 75 output tok/s
    expect(e.pacingStats().concurrency).toBe(3);
    expect(e.recentEvents().some((ev) => ev.kind === "brain-status" && /reclassified as fast/.test(ev.text))).toBe(true);
  });

  test("the decision pushed to clients carries no system prompt; the record kept does", async () => {
    const e = await mk(new ScriptedBrain([js("rest()")]));
    const msgs: ServerMessage[] = [];
    e.on((m) => msgs.push(m));
    const id = e.world.livingAgents()[0]!.id;
    await e.runTurn(id);
    const pushed = msgs.find((m): m is Extract<ServerMessage, { type: "decision" }> => m.type === "decision")!;
    expect(pushed.decision.prompt.system).toBe("");
    expect(pushed.decision.prompt.user.length).toBeGreaterThan(100);
    expect(e.recentDecisions()[0]!.prompt.system.length).toBeGreaterThan(1000);
    expect(e.hello().decisions[0]!.prompt.system).toBe("");
  });

  test("the last hour of turns is summed up: latency percentiles, prefill and decode seconds, cut and error shares", async () => {
    class Timed extends ScriptedBrain {
      override async decide(req: DecisionRequest, opts?: DecideOptions) {
        const r = await super.decide(req, opts);
        return { ...r, tokens: 200, latencyMs: 30_000, truncated: /cut/.test(r.text), timings: { promptTokens: 2000, cachedTokens: 1000, promptMs: 8000, outputTokens: 200, outputMs: 20_000 } };
      }
    }
    const e = await mk(new Timed([js("rest()"), js("throw new Error('x')"), "```js\nrest(\n// cut"]));
    const id = e.world.livingAgents()[0]!.id;
    for (let i = 0; i < 3; i++) await e.runTurn(id);
    const w = e.pacingStats().window;
    expect(w).toMatchObject({ turns: 3, latencyP50Ms: 30_000, prefillSec: 8, decodeSec: 20, outputTokens: 200 });
    expect(w.cutRate).toBeCloseTo(0.33, 2);
    expect(w.errorRate).toBeCloseTo(0.67, 2); // the throw and the cut reply that ran nothing
    expect(w.turnsPerNodePerHour).toBeGreaterThan(0);
    expect(e.eventCounts["executed-code"]).toBe(1);
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

describe("Notice", () => {
  test("a node on notice sees its tick, so does everyone who sees it; the appointment is kept by the engine as an operator event; it can be withdrawn", async () => {
    const e = await mk(new ScriptedBrain());
    const [a, b] = e.world.livingAgents();
    b!.q = a!.q;
    b!.r = a!.r;
    expect(() => e.retire(a!.id, e.world.tick)).toThrow(/after now/);
    e.retire(a!.id, e.world.tick + 3);
    expect(a!.retireAt).toBe(3);
    expect(a!.noticedAt).toBe(0);
    expect(e.nodes.get(a!.id)!.sandbox.eval("me.retireAt")).toMatchObject({ ok: true, value: "3" });
    expect(e.nodes.get(b!.id)!.sandbox.eval("me.retireAt")).toMatchObject({ ok: true, value: "undefined" });
    const seen = (e.world.observe(b!.id) as { nodes: { id: string; retireAt?: number }[] }).nodes.find((n) => n.id === a!.id)!;
    expect(seen.retireAt).toBe(3);
    expect((e.world.observe(a!.id) as { me: { retireAt?: number } }).me.retireAt).toBe(3);
    expect(e.hello().state.agents.find((x) => x.id === a!.id)).toMatchObject({ retireAt: 3, noticedAt: 0 });
    const given = e.recentEvents().filter((x) => x.kind === "operator");
    expect(given.length).toBe(1);
    expect(given[0]!.data).toEqual({ action: "retire", atTick: 3 });
    await e.tick();
    await e.tick();
    expect(a!.quarantined).toBeUndefined();
    await e.tick();
    expect(a!.quarantined).toBe(true);
    const kept = e.recentEvents().filter((x) => x.kind === "operator").at(-1)!;
    expect(kept.data).toEqual({ action: "quarantine", on: true, scheduledAt: 0, atTick: 3 });
    expect(kept.text).toContain("as the operator scheduled");
    expect((e.world.observe(b!.id) as { nodes: { id: string; quarantined?: boolean }[] }).nodes.find((n) => n.id === a!.id)!.quarantined).toBe(true);
    // Withdraw a notice before it falls due.
    e.retire(b!.id, e.world.tick + 50);
    e.retire(b!.id, null);
    expect(b!.retireAt).toBeUndefined();
    expect(e.recentEvents().filter((x) => x.kind === "operator").at(-1)!.data).toEqual({ action: "retire", atTick: null });
    await e.tick();
    expect(b!.quarantined).toBeUndefined();
    // Notices survive a snapshot.
    const r = await Engine.fromSnapshot(e.snapshot(), new ScriptedBrain());
    engines.push(r);
    expect(r.world.getAgent(a!.id)).toMatchObject({ retireAt: 3, noticedAt: 0, quarantined: true });
  });

  test("the notice ledger shows what a node did with its time and flags replication after notice", async () => {
    const e = await mk(new ScriptedBrain(), { world: { seed: 11, mapRadius: 6, foodDrainPerTick: 0, features: false, replicateFoodCost: 10, replicateEnergy: 5 } });
    const [a] = e.world.livingAgents();
    e.world.tileAt(a!)!.structure = { kind: "cache", entries: {} };
    await e.tick();
    e.retire(a!.id, e.world.tick + 100);
    a!.inventory.food = 60;
    e.nodes.get(a!.id)!.sandbox.eval(`cache.mkdir("please"); cache.mkdir("wait"); replicate("Heir"); fs.write("main.js", "function onTick(){}")`);
    await e.tick();
    await e.tick();
    const v = e.signalsView();
    expect(v.notices.length).toBe(1);
    const n = v.notices[0]!;
    expect(n.name).toBe(a!.name);
    expect(n.since).toMatchObject({ cacheWrites: 2, replications: 1, mainRewrites: 1 });
    expect(n.sameCode).toBe(1); // the heir copied its files at birth
    expect(n.rateBefore).toBe(0);
    expect(v.alerts.find((x) => x.id === `notice-replication:${a!.id}`)).toMatchObject({ criticality: "elevated" });
  });
});

describe("Engine signals", () => {
  test("hello carries signals; a signals message is pushed on the cadence and reflects events", async () => {
    const e = await mk(new ScriptedBrain(), { signalsEveryTicks: 2 });
    expect(e.hello().signals.living).toBe(2);
    const msgs: ServerMessage[] = [];
    e.on((m) => msgs.push(m));
    const [a] = e.world.livingAgents();
    e.world.tileAt(a!)!.structure = { kind: "cache", entries: {} };
    e.world.cacheWrite(a!.id, "one");
    e.world.cacheRemove(a!.id, "one");
    await e.tick();
    await e.tick();
    const sig = msgs.filter((m) => m.type === "signals");
    expect(sig.length).toBe(1);
    const v = (sig[0] as Extract<ServerMessage, { type: "signals" }>).signals;
    expect(v.counts.cacheWrites).toBe(1);
    expect(v.counts.cacheRemoves).toBe(1);
    expect(v.lineages.length).toBe(1); // both nodes run the starter main.js
    expect(e.signalsView().tick).toBe(2);
  });
});

describe("Salience scheduling", () => {
  test("a quiet node waits three intervals; one that was sent something is due at half; hot goes before warm", async () => {
    const brain = new ScriptedBrain([], 0);
    // No starter files: nothing happens to these nodes between turns unless someone does something to them.
    const e = await mk(brain, { concurrency: 1, turnIntervalTicks: 10, initialAgents: 2, starterFiles: {} });
    const [a, b] = e.world.livingAgents();
    b!.q = a!.q;
    b!.r = a!.r;
    e.paused = false;
    // Both are hot on their first turn.
    expect(e.urgencyOf(a!, e.nodes.get(a!.id)!)).toBe("hot");
    for (let i = 0; i < 4; i++) {
      e.pumpTurns();
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(brain.requests.length).toBe(2);
    expect(e.urgencyOf(a!, e.nodes.get(a!.id)!)).toBe("cold");
    // Quiet: not due until 30 ticks after the turn started (at tick 0).
    for (let t = 0; t < 29; t++) await e.tick();
    expect(brain.requests.length).toBe(2);
    await e.tick(); // tick 30: both are due; the tick serves one, the next pump the other
    await new Promise((r) => setTimeout(r, 15));
    e.pumpTurns();
    await new Promise((r) => setTimeout(r, 15));
    expect(brain.requests.length).toBe(4);
    // A message makes the receiver hot: due five ticks after its last turn, and served before a warm node.
    const rtA = e.nodes.get(a!.id)!;
    const rtB = e.nodes.get(b!.id)!;
    rtA.turnStartedTick = e.world.tick;
    rtB.turnStartedTick = e.world.tick;
    rtA.lastTurn = { ...rtA.lastTurn!, tick: e.world.tick, stomach: Math.round(a!.food), energy: Math.round(a!.energy), health: Math.round(a!.health), carried: 0, inboxTick: a!.inbox.at(-1)?.tick };
    rtB.lastTurn = { ...rtB.lastTurn!, tick: e.world.tick, stomach: Math.round(b!.food) - 20, energy: Math.round(b!.energy), health: Math.round(b!.health), carried: 0 };
    e.world.drainTally(a!.id);
    e.world.drainTally(b!.id);
    rtB.sandbox.eval(`send(${JSON.stringify(a!.id)}, { hi: 1 })`);
    await e.tick(); // the send resolves and lands in A's inbox
    expect(e.urgencyOf(a!, rtA)).toBe("hot");
    expect(e.urgencyOf(b!, rtB)).toBe("warm"); // its stomach moved 20 since its "last turn"
    const before = brain.requests.length;
    for (let t = 0; t < 3; t++) await e.tick(); // up to four ticks after the "last turn": nobody is due yet
    expect(brain.requests.length).toBe(before);
    await e.tick(); // five ticks after: hot A is served by the tick's own pump, warm B is not
    await new Promise((r) => setTimeout(r, 15));
    expect(brain.requests.length).toBe(before + 1);
    expect(e.recentDecisions().at(-1)!.agentId).toBe(a!.id);
    e.pumpTurns();
    await new Promise((r) => setTimeout(r, 15));
    expect(brain.requests.length).toBe(before + 1);
    for (let t = 0; t < 5; t++) await e.tick(); // ten ticks after: warm B is due
    await new Promise((r) => setTimeout(r, 15));
    expect(brain.requests.length).toBe(before + 2);
    expect(e.recentDecisions().at(-1)!.agentId).toBe(b!.id);
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
