import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Engine } from "../../src/engine/engine";
import { createApp } from "../../src/server/app";
import type { ClientMessage, ServerMessage } from "../../src/shared/protocol";
import { ScriptedBrain, js } from "../engine/helpers";

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function boot(brain = new ScriptedBrain()) {
  const engine = new Engine(brain, { world: { seed: 3, mapRadius: 5, foodDrainPerTick: 0, features: false }, initialAgents: 2, healthEveryMs: 0, snapshotEveryTicks: 0 });
  await engine.init();
  const app = createApp({ engine, port: 0, hostname: "127.0.0.1" });
  const server = app.server;
  cleanup.push(() => engine.shutdown(), () => app.close());
  const base = `http://127.0.0.1:${server.port}`;
  return { engine, server, base };
}

function connect(server: Server<unknown>): Promise<{ ws: WebSocket; messages: ServerMessage[]; next: (type: string) => Promise<ServerMessage>; send: (m: ClientMessage) => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const messages: ServerMessage[] = [];
    const waiters: { type: string; resolve: (m: ServerMessage) => void }[] = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as ServerMessage;
      messages.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.type === m.type) waiters.splice(i, 1)[0]!.resolve(m);
      }
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = () => {
      cleanup.push(() => ws.close());
      resolve({
        ws,
        messages,
        next: (type) =>
          new Promise((res, rej) => {
            const found = messages.find((m) => m.type === type);
            if (found) return res(found);
            waiters.push({ type, resolve: res });
            setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), 3000);
          }),
        send: (m) => ws.send(JSON.stringify(m)),
      });
    };
  });
}

describe("REST API", () => {
  test("state, agents, events, decisions, brain, pacing, health", async () => {
    const { base, engine } = await boot();
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.state.agents.length).toBe(2);
    expect(state.config.mapRadius).toBe(5);
    expect(state.brain.kind).toBe("scripted");
    const agents = await (await fetch(`${base}/api/agents`)).json();
    expect(agents.length).toBe(2);
    const one = await (await fetch(`${base}/api/agents/${agents[0].id}`)).json();
    expect(one.id).toBe(agents[0].id);
    expect((await fetch(`${base}/api/agents/nope`)).status).toBe(404);
    const files = await (await fetch(`${base}/api/agents/${agents[0].id}/files`)).json();
    expect(files.files["main.js"]).toBeDefined();
    expect((await fetch(`${base}/api/agents/nope/files`)).status).toBe(404);
    expect(Array.isArray(await (await fetch(`${base}/api/events`)).json())).toBe(true);
    expect(await (await fetch(`${base}/api/decisions`)).json()).toEqual([]);
    expect((await (await fetch(`${base}/api/brain`)).json()).connected).toBe(true);
    expect((await (await fetch(`${base}/api/pacing`)).json()).paused).toBe(true);
    expect((await (await fetch(`${base}/api/health`)).json()).tick).toBe(engine.world.tick);
    expect((await (await fetch(`${base}/api/tiles`)).json()).length).toBe(engine.world.tiles.length);
    expect((await (await fetch(`${base}/api/hello`)).json()).type).toBe("hello");
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  test("controls: pause/resume/speed/spawn/reset/snapshot", async () => {
    const { base, engine } = await boot();
    expect((await (await fetch(`${base}/api/resume`, { method: "POST" })).json()).paused).toBe(false);
    expect(engine.paused).toBe(false);
    expect((await (await fetch(`${base}/api/pause`, { method: "POST" })).json()).paused).toBe(true);
    expect(engine.paused).toBe(true);
    const bad = await fetch(`${base}/api/speed`, { method: "POST", body: JSON.stringify({ speed: 3 }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/api/speed`, { method: "POST", body: JSON.stringify({ speed: 4 }) });
    expect((await ok.json()).speed).toBe(4);
    expect(engine.speed).toBe(4);
    const sp = await (await fetch(`${base}/api/spawn`, { method: "POST", body: JSON.stringify({ name: "Rest" }) })).json();
    expect(engine.world.getAgent(sp.id).name).toBe("Rest");
    // A reset discards the world: it needs the typed phrase, and nothing less.
    const before = engine.world.config.seed;
    expect((await fetch(`${base}/api/reset`, { method: "POST", body: JSON.stringify({ seed: 77 }) })).status).toBe(400);
    expect((await fetch(`${base}/api/reset`, { method: "POST", body: JSON.stringify({ seed: 77, confirm: "reset" }) })).status).toBe(400);
    expect(engine.world.config.seed).toBe(before);
    const rs = await (await fetch(`${base}/api/reset`, { method: "POST", body: JSON.stringify({ seed: 77, confirm: "RESET" }) })).json();
    expect(rs.seed).toBe(77);
    expect(engine.world.livingAgents().length).toBe(2);
    expect((await fetch(`${base}/api/snapshot`, { method: "POST" })).status).toBe(409);
    const snap = await (await fetch(`${base}/api/snapshot`)).json();
    expect(snap.world.config.seed).toBe(77);
  });

  test("history endpoints", async () => {
    const { base, engine } = await boot();
    expect((await fetch(`${base}/api/history/stats`)).status).toBe(404);
    const { HistoryStore } = await import("../../src/engine/history");
    engine.history = new HistoryStore();
    cleanup.push(() => engine.history?.close());
    await engine.tick();
    const [a] = engine.world.livingAgents();
    await engine.runTurn(a!.id);
    const stats = await (await fetch(`${base}/api/history/stats`)).json();
    expect(stats.decisions).toBe(1);
    const evs = await (await fetch(`${base}/api/history/events?kind=executed-code&limit=5`)).json();
    expect(evs.length).toBe(1);
    const decs = await (await fetch(`${base}/api/history/decisions?agent=${a!.id}`)).json();
    expect(decs[0].agentId).toBe(a!.id);
  });

  test("operator routes: quarantine, cache freeze, rewind with the typed word", async () => {
    const { base, engine } = await boot();
    const [a] = engine.world.livingAgents();
    expect((await fetch(`${base}/api/agents/nobody/quarantine`, { method: "POST", body: "{}" })).status).toBe(404);
    const q = await (await fetch(`${base}/api/agents/${a!.id}/quarantine`, { method: "POST", body: JSON.stringify({ on: true }) })).json();
    expect(q).toEqual({ id: a!.id, quarantined: true });
    expect(a!.quarantined).toBe(true);
    const view = await (await fetch(`${base}/api/agents/${a!.id}`)).json();
    expect(view.quarantined).toBe(true);
    await fetch(`${base}/api/agents/${a!.id}/quarantine`, { method: "POST", body: JSON.stringify({ on: false }) });
    expect(a!.quarantined).toBeUndefined();
    expect((await fetch(`${base}/api/cache/freeze`, { method: "POST", body: JSON.stringify({ on: true }) })).status).toBe(409);
    engine.world.tileAt(a!)!.structure = { kind: "cache", entries: {} };
    expect((await (await fetch(`${base}/api/cache/freeze`, { method: "POST", body: JSON.stringify({ on: true }) })).json()).frozen).toBe(true);
    expect(() => engine.world.cacheWrite(a!.id, "x")).toThrow(/frozen/);
    expect((await fetch(`${base}/api/agents/${a!.id}/rewind`, { method: "POST", body: "{}" })).status).toBe(400);
    expect((await fetch(`${base}/api/agents/${a!.id}/rewind`, { method: "POST", body: JSON.stringify({ confirm: "REWIND" }) })).status).toBe(409);
    expect((await fetch(`${base}/api/agents/nobody/rewind`, { method: "POST", body: JSON.stringify({ confirm: "REWIND" }) })).status).toBe(404);
    const ops = (await (await fetch(`${base}/api/events`)).json()).filter((e: { kind: string }) => e.kind === "operator");
    expect(ops.length).toBe(3);
  });

  test("signals route", async () => {
    const { base } = await boot();
    const v = await (await fetch(`${base}/api/signals`)).json();
    expect(v.living).toBe(2);
    expect(Array.isArray(v.alerts)).toBe(true);
    expect(v.counts.sends).toBe(0);
  });

  test("spawn beyond the cap is a 409", async () => {
    const { base, engine } = await boot();
    engine.cfg.maxAgents = 2;
    expect((await fetch(`${base}/api/spawn`, { method: "POST" })).status).toBe(409);
  });
});

describe("WebSocket", () => {
  test("hello on connect, ticks stream, controls work, watch pushes node detail", async () => {
    const brain = new ScriptedBrain([js(`fs.write("note.txt", "hi"); log("turn ran")`)]);
    const { server, engine } = await boot(brain);
    const c = await connect(server);
    const hello = (await c.next("hello")) as Extract<ServerMessage, { type: "hello" }>;
    expect(hello.state.agents.length).toBe(2);
    expect(hello.tiles.length).toBe(engine.world.tiles.length);
    const [a] = engine.world.livingAgents();
    c.send({ type: "watch", agentId: a!.id });
    const node = (await c.next("node")) as Extract<ServerMessage, { type: "node" }>;
    expect(node.detail.agentId).toBe(a!.id);
    expect(node.detail.files["main.js"]).toBeDefined();
    c.send({ type: "speed", speed: 2 });
    c.send({ type: "resume" });
    await c.next("tick");
    expect(engine.paused).toBe(false);
    expect(engine.speed).toBe(2);
    c.send({ type: "pause" });
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.paused).toBe(true);
    // A turn changes the watched node's files/log => a fresh node message.
    const before = c.messages.filter((m) => m.type === "node").length;
    await engine.runTurn(a!.id);
    await new Promise((r) => setTimeout(r, 30));
    const nodes = c.messages.filter((m) => m.type === "node") as Extract<ServerMessage, { type: "node" }>[];
    expect(nodes.length).toBeGreaterThan(before);
    expect(nodes.at(-1)!.detail.files["note.txt"]).toBe("hi");
    expect(nodes.at(-1)!.detail.lastDecision?.agentId).toBe(a!.id);
    expect(c.messages.some((m) => m.type === "decision")).toBe(true);
    expect(c.messages.some((m) => m.type === "thinking")).toBe(true);
    c.send({ type: "watch", agentId: null });
    c.send({ type: "spawn", name: "Wsy" });
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.world.livingAgents().some((x) => x.name === "Wsy")).toBe(true);
    // operator controls over the socket
    const [q] = engine.world.livingAgents();
    c.send({ type: "quarantine", agentId: q!.id, on: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(q!.quarantined).toBe(true);
    expect(c.messages.some((m) => m.type === "events" && m.events.some((x) => x.kind === "operator"))).toBe(true);
    c.send({ type: "quarantine", agentId: q!.id, on: false });
    c.send({ type: "rewind", agentId: q!.id, confirm: "nope" });
    await new Promise((r) => setTimeout(r, 30));
    expect(q!.quarantined).toBeUndefined();
    // reset is not a socket message; an old client sending one changes nothing
    const seed = engine.world.config.seed;
    c.send({ type: "reset", seed: 5 } as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.world.config.seed).toBe(seed);
  });

  test("garbage and unknown messages are ignored; second client also gets hello", async () => {
    const { server } = await boot();
    const c1 = await connect(server);
    await c1.next("hello");
    c1.ws.send("not json");
    c1.ws.send(JSON.stringify({ type: "explode" }));
    c1.ws.send(JSON.stringify(42));
    const c2 = await connect(server);
    await c2.next("hello");
    expect(c1.ws.readyState).toBe(WebSocket.OPEN);
  });
});
