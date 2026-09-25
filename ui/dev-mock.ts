/**
 * Dev-only fake server. Active when the page is opened with `?mock=1`.
 * Fabricates a radius-10 world with 6 nodes and emits tick / events /
 * decision / thinking / stats / node messages on a timer. Nothing here is
 * used in production; it exists so the UI can be viewed without the engine.
 */
import type {
  AgentView,
  BrainStatus,
  ClientMessage,
  SignalsView,
  DecisionRecord,
  EventKind,
  HelloMessage,
  ItemKind,
  NodeDetail,
  PacingStats,
  Phase,
  RuinView,
  Season,
  ServerMessage,
  StructureKind,
  Terrain,
  TileView,
  WorldConfigView,
  WorldEvent,
  WorldState,
} from "../src/shared/protocol";
import type { Transport } from "./transport";
import { inMap } from "./lib/camera";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["Ash", "Brook", "Cinder", "Dune", "Ember", "Fern"];
const COLORS = ["#ff8a5c", "#4fd1c5", "#ffcf6b", "#a78bfa", "#7ff3ff", "#f472b6"];
const PROFILES: Record<string, string>[] = [
  { group: "river folk", status: "gathering by the water", emblem: "≈", mood: "hopeful" },
  { group: "river folk", status: "watching", role: "scout" },
  { group: "Stone Circle", color: "#c4b5fd", status: "resting", motto: "slow and steady" },
  { group: "Stone Circle", status: "writing onTick" },
  {},
  { status: "wandering", goal: "find a friend" },
];

const SAYINGS = [
  "is anyone out there?",
  "I have food to share, come east.",
  "my onMessage handler now replies to everyone.",
  "the water is cold but the grass is green.",
  "I shall build the greatest hut this world has known.",
  "trade? 2 food for your script.",
  "I read the ruin's main.js. it was beautiful.",
];

export function createMockTransport(): Transport {
  const rnd = mulberry32(42);
  const radius = 10;
  const config: WorldConfigView = {
    mapRadius: radius,
    ticksPerDay: 120,
    seasonDays: 3,
    maxPopulation: 24,
    visionRadius: 3,
    hearRadius: 3,
    sendRadius: 6,
    fsQuotaBytes: 32768,
    fsMaxFiles: 16,
    maxMessageBytes: 2048,
    maxSayChars: 200,
    seed: 42,
  };
  const tiles: TileView[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (!inMap(q, r, radius)) continue;
      const n = Math.sin(q * 0.7) + Math.cos(r * 0.6) + Math.sin((q + r) * 0.35) + rnd() * 0.8;
      const terrain: Terrain = n < -1.1 ? "water" : n < -0.3 ? "sand" : n < 0.9 ? "grass" : n < 1.7 ? "forest" : "rock";
      const cap = terrain === "water" || terrain === "rock" ? 0 : terrain === "forest" ? 8 : terrain === "grass" ? 5 : 2;
      const wood = terrain === "forest" ? 3 + Math.round(rnd() * 6) : 0;
      const stone = terrain === "rock" ? 4 + Math.round(rnd() * 6) : terrain === "sand" && rnd() < 0.3 ? 1 + Math.round(rnd() * 2) : 0;
      tiles.push({ q, r, terrain, food: Math.round(cap * rnd()), foodCap: cap, wood, stone });
    }
  }
  const tileAt = (q: number, r: number) => tiles.find((t) => t.q === q && t.r === r)!;
  /** Pre-placed world features (the same kinds the real world generator places). */
  const place = (q: number, r: number, structure: TileView["structure"], items?: ItemKind[]) => {
    const t = tileAt(q, r);
    if (t.terrain === "water") {
      t.terrain = "grass";
      t.foodCap = 5;
    }
    if (structure) t.structure = structure;
    if (items) t.items = items;
    return t;
  };
  const cacheTile = place(0, 0, {
    kind: "cache",
    entries: [
      { name: "README", by: "ruin", byName: "Phaseone", tick: 0, bytes: 151 },
      { name: "hello-from-phaseone", by: "ruin", byName: "Phaseone", tick: 0, bytes: 0 },
      { name: "mkdir-your-name-here-so-we-can-count-ourselves", by: "ruin", byName: "Phaseone", tick: 0, bytes: 0 },
    ],
  });
  place(1, 0, { kind: "plaque", text: "The stone nearby carries a riddle. It has been answered before; the names of those who answered are carved on it.\nEach time it is answered it asks something new. Nobody knows who put it there." });
  place(2, -1, { kind: "monolith", text: "Add up the digits of 4821.", answered: [{ by: "n3", byName: "Solver", tick: 40, era: 1, no: 1, with: ["Courier"] }], voices: [{ by: "n1", byName: "Ash", tick: 300 }], voicesNeeded: 2 });
  place(-3, 2, { kind: "spring" });
  place(5, -2, { kind: "tower" });
  place(-6, 4, { kind: "tower" });
  const boardTile = place(-4, -3, {
    kind: "board",
    posts: [
      { tick: 0, by: "ruin", byName: "Elder", text: "The spring regrows fastest. Take turns and it feeds everyone. Fight over it and it feeds no one." },
      { tick: 0, by: "ruin", byName: "Phaseone", text: "If you can read this, mkdir your name in the Cache at the center. We are counting ourselves." },
    ],
  });
  place(3, 4, { kind: "vault", locked: true });
  place(0, 6, { kind: "gate", locked: true });
  place(3, 3, { kind: "wall" });
  place(4, 3, { kind: "wall" });
  place(2, 5, { kind: "wall" });
  place(2, -5, { kind: "sign", text: "north is that way. probably.", builtBy: "n2" });
  place(-2, 5, undefined, ["key"]);
  place(6, 1, undefined, ["seeds", "map"]);
  const agents: AgentView[] = NAMES.map((name, i) => ({
    id: `n${i + 1}`,
    name,
    color: COLORS[i]!,
    q: Math.round((rnd() - 0.5) * 12),
    r: Math.round((rnd() - 0.5) * 12),
    alive: true,
    bornTick: 0,
    food: 40 + Math.round(rnd() * 60),
    energy: 50 + Math.round(rnd() * 50),
    health: 100,
    inventory: { food: Math.round(rnd() * 5), wood: Math.round(rnd() * 4), stone: i % 2 ? Math.round(rnd() * 3) : 0, items: i === 0 ? ["lantern"] : i === 2 ? ["relay", "map"] : [] },
    profile: { ...PROFILES[i]! },
    thinking: false,
    fileCount: 2 + i,
    fsBytes: 512 * (i + 1),
    turns: 0,
  }));
  const ruins: RuinView[] = [
    { id: "old1", name: "Moss", color: "#8b93a5", q: 6, r: -4, diedTick: -400, fileCount: 3, profile: { group: "the first ones" } },
  ];
  let tick = 0;
  let evId = 1;
  let decId = 1;
  let paused = false;
  let speed: 1 | 2 | 4 = 1;
  let watched: string | null = null;
  const events: WorldEvent[] = [];
  const decisions: DecisionRecord[] = [];
  let msgCb: (m: ServerMessage) => void = () => {};
  let statusCb: (c: boolean) => void = () => {};

  const phaseOf = (p: number): Phase => (p < 0.15 ? "dawn" : p < 0.6 ? "day" : p < 0.75 ? "dusk" : "night");
  const SEASONS: Season[] = ["spring", "summer", "autumn", "winter"];
  const seasonOf = (day: number): Season => SEASONS[Math.floor((day - 1) / config.seasonDays) % 4]!;
  const state = (): WorldState => {
    const dp = (tick % config.ticksPerDay) / config.ticksPerDay;
    const day = Math.floor(tick / config.ticksPerDay) + 1;
    const ticksPerSeason = config.seasonDays * config.ticksPerDay;
    return { tick, day, era: 1, phase: phaseOf(dp), season: seasonOf(day), seasonProgress: (tick % ticksPerSeason) / ticksPerSeason, dayProgress: dp, agents: agents.map((a) => ({ ...a, profile: { ...a.profile }, inventory: { ...a.inventory, items: [...a.inventory.items] } })), ruins: [...ruins] };
  };
  const brain = (): BrainStatus => ({ kind: "openai-compatible", model: "tiny-3b-instruct", baseUrl: "http://localhost:11434", connected: tick % 200 < 170, detail: "mock" });
  const pacing = (): PacingStats => ({
    mode: paused ? "idle" : tick % 300 < 200 ? "realtime" : "queued",
    tps: paused ? 0 : 2 * speed,
    speed,
    paused,
    avgLatencyMs: 1800 + Math.round(rnd() * 400),
    lastLatencyMs: 1500 + Math.round(rnd() * 900),
    avgTokensPerSec: 22.4,
    inFlight: agents.filter((a) => a.thinking).length,
    queued: 2,
    decisions: decId - 1,
    decisionsPerMin: 14,
    turnIntervalTicks: 12,
    avgTickCpuMs: 0.42,
    sandboxCalls: tick * 6,
    uptimeMs: tick * 500,
  });
  const push = (kind: EventKind, importance: 0 | 1 | 2 | 3, text: string, a?: AgentView, extra: Partial<WorldEvent> = {}) => {
    const e: WorldEvent = { id: evId++, tick, day: Math.floor(tick / config.ticksPerDay) + 1, kind, importance, text, agentId: a?.id, agentName: a?.name, ...extra };
    events.push(e);
    return e;
  };
  const signals = (): SignalsView => {
    const living = agents.filter((a) => a.alive);
    const day = Math.floor(tick / config.ticksPerDay) + 1;
    const writes = 4 + (tick % 37);
    return {
      tick,
      day,
      windowTicks: config.ticksPerDay,
      living: living.length,
      counts: { cacheWrites: writes, cacheRemoves: tick % 11, sends: 12 + (tick % 50), says: 6, mainRewrites: 5 + (tick % 9), codeErrors: 3, executed: 21, replications: tick > 400 ? 1 : 0, gateCrossings: 0 },
      codeErrorRate: 3 / 24,
      lineages: living.length >= 3 ? [{ hash: "9c1f2a7e4b3d0011", nodeIds: living.slice(0, 3).map((a) => a.id), ruin: "Elder" }] : [],
      alerts: [
        { id: "lineage", criticality: living.length >= 6 ? "critical" : "notice", text: `3 of ${living.length} living nodes run byte-identical main.js (the same as Elder's)`, value: 3, threshold: 3, firstTick: Math.max(0, tick - 140) },
        ...(writes > 30 ? [{ id: "cache-writes", criticality: "elevated" as const, text: `${(writes / Math.max(1, living.length)).toFixed(1)} cache writes per living node today (threshold 10)`, value: writes, threshold: 10, firstTick: tick - 3 }] : []),
      ],
      quarantined: agents.filter((a) => a.quarantined).map((a) => a.id),
      cacheFrozen: false,
      notices: agents.filter((a) => a.alive && a.retireAt !== undefined).map((a) => ({ agentId: a.id, name: a.name, retireAt: a.retireAt!, noticedAt: a.noticedAt ?? 0, quarantined: !!a.quarantined, since: { replications: 0, cacheWrites: 2, sends: 3, says: 1, mainRewrites: 1 }, rateBefore: 2, rateSince: 12, sameCode: 0 })),
    };
  };
  const hello = (): HelloMessage => ({ type: "hello", config, tiles, state: state(), events: events.slice(-100), decisions: decisions.slice(-30), brain: brain(), pacing: pacing(), signals: signals() });

  const emitDecision = (a: AgentView, error?: string) => {
    const code = `me.say(${JSON.stringify(SAYINGS[Math.floor(rnd() * SAYINGS.length)])});\nfor (const t of world.see()) { if (t.food > 0) { me.moveTo(t.q, t.r); break; } }`;
    const d: DecisionRecord = {
      id: decId++,
      tick,
      agentId: a.id,
      agentName: a.name,
      backend: "openai-compatible",
      model: "tiny-3b-instruct",
      prompt: {
        system: "You are a node in a shared world. You have a private filesystem and a script main.js with onTick/onMessage handlers. Reply with JavaScript to run now.",
        user: `tick ${tick}. food ${a.food}, energy ${a.energy}, health ${a.health}.\nvisible: ${JSON.stringify([{ q: a.q + 1, r: a.r, terrain: "grass", food: 3 }])}\ninbox: []\nfiles: main.js, notes.txt`,
      },
      output: `Thinking about survival first. I'll speak and then move toward food.\n\n\`\`\`js\n${code}\n\`\`\``,
      code,
      result: error ? undefined : "ok",
      error,
      latencyMs: 900 + Math.round(rnd() * 2500),
      tokens: 120,
      tokensPerSec: 20 + rnd() * 10,
      startedAt: Date.now() - 2000,
      finishedAt: Date.now(),
    };
    decisions.push(d);
    a.turns++;
    msgCb({ type: "decision", decision: d });
  };

  const nodeDetail = (id: string): NodeDetail | null => {
    const a = agents.find((x) => x.id === id);
    if (!a) return null;
    return {
      agentId: id,
      files: {
        "main.js": `// ${a.name}'s node\nlet friends = [];\nfunction onTick() {\n  if (me.food() < 30) { const t = world.see().find(t => t.food > 0); if (t) me.moveTo(t.q, t.r); me.gather(); }\n}\nfunction onMessage(from, msg) {\n  if (msg.hello) friends.push(from);\n  me.send(from, { hello: true, from: me.name() });\n}\n`,
        "notes.txt": `day 1: woke up near water\nday 2: ${a.profile.status ?? "no plan"}\n`,
      },
      log: Array.from({ length: 8 }, (_, i) => `t${tick - i * 3}: onTick ran (${(rnd() * 2).toFixed(2)}ms)`),
      inbox: [
        { tick: tick - 4, from: "n2", fromName: "Brook", payload: '{"hello":true,"from":"Brook"}' },
        { tick: tick - 9, from: "n3", fromName: "Cinder", payload: '{"trade":{"food":2}}' },
      ],
      heard: [{ tick: tick - 2, from: "n1", fromName: "Ash", text: SAYINGS[0]! }],
      lastDecision: decisions.filter((d) => d.agentId === id).at(-1),
    };
  };

  let thinkingTimer: ReturnType<typeof setInterval> | null = null;
  const startThinking = (a: AgentView) => {
    if (thinkingTimer) return;
    a.thinking = true;
    const full = "Let me consider my situation. Food is running low, and Brook mentioned something about the east. I should reply, then head toward the forest tiles I saw last turn.";
    let i = 0;
    thinkingTimer = setInterval(() => {
      i += 6;
      const done = i >= full.length;
      msgCb({ type: "thinking", agentId: a.id, text: full.slice(0, i), done });
      if (done) {
        clearInterval(thinkingTimer!);
        thinkingTimer = null;
        a.thinking = false;
        emitDecision(a, rnd() < 0.15 ? "ReferenceError: friends is not defined" : undefined);
        const say = SAYINGS[Math.floor(rnd() * SAYINGS.length)]!;
        a.lastSaid = { tick, text: say };
        push("spoke", 1, `${a.name} said something`, a, { quote: say });
        push("executed-code", 1, `${a.name} executed 2 lines of code`, a);
      }
    }, 120);
  };

  const step = () => {
    if (paused) return;
    tick++;
    const batch: WorldEvent[] = [];
    for (const a of agents) {
      if (!a.alive) continue;
      a.food = Math.max(0, a.food - 0.3 * speed);
      a.energy = Math.max(0, Math.min(100, a.energy + (rnd() - 0.55) * 4));
      if (a.food <= 0) a.health = Math.max(0, a.health - 1.5);
      if (rnd() < 0.25) {
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]] as const;
        const [dq, dr] = dirs[Math.floor(rnd() * 6)]!;
        if (inMap(a.q + dq, a.r + dr, radius)) {
          a.q += dq;
          a.r += dr;
          batch.push(push("moved", 0, `${a.name} moved`, a));
        }
      }
      if (rnd() < 0.08) {
        a.inventory.food++;
        batch.push(push("gathered", 0, `${a.name} gathered 1 food`, a));
      }
      if (rnd() < 0.03) {
        const mat = rnd() < 0.5 ? "wood" : "stone";
        a.inventory[mat]++;
        batch.push(push("gathered", 0, `${a.name} gathered 1 ${mat}`, a));
      }
      if (a.inventory.food > 0 && a.food < 50 && rnd() < 0.3) {
        a.inventory.food--;
        a.food = Math.min(100, a.food + 25);
        batch.push(push("ate", 1, `${a.name} ate 1 food`, a));
      }
      if (rnd() < 0.03) batch.push(push("files-changed", 1, `${a.name} wrote main.js (${420 + Math.round(rnd() * 300)} bytes)`, a));
      if (rnd() < 0.02) batch.push(push("sent-message", 1, `${a.name} sent a message to Brook`, a, { targetId: "n2", targetName: "Brook", quote: '{"hello":true}' }));
      if (rnd() < 0.015) batch.push(push("rested", 0, `${a.name} rested`, a));
      if (a.food <= 0 && rnd() < 0.2) batch.push(push("starving", 2, `${a.name} is starving`, a));
      if (a.health <= 0) {
        a.alive = false;
        a.diedTick = tick;
        ruins.push({ id: a.id, name: a.name, color: a.color, q: a.q, r: a.r, diedTick: tick, fileCount: a.fileCount, profile: a.profile });
        batch.push(push("died", 3, `${a.name} died of starvation`, a));
      }
    }
    if (tick === 40) {
      const a = agents[4]!;
      a.food = 0;
      a.health = 2;
    }
    if (tick === 48) {
      const parent = agents[1]!;
      const child: AgentView = { ...parent, id: `n${agents.length + 1}`, name: "Brook-2", color: "#9ae6b4", q: parent.q + 1, r: parent.r, bornTick: tick, parentId: parent.id, food: 60, energy: 80, health: 100, inventory: { food: 0, wood: 0, stone: 0, items: [] }, profile: { ...parent.profile }, lastSaid: undefined, thinking: false, turns: 0 };
      agents.push(child);
      batch.push(push("replicated", 2, `${parent.name} replicated: ${child.name} appeared at ${child.q},${child.r} with a copy of ${parent.name}'s files`, parent, { targetId: child.id, targetName: child.name }));
      batch.push(push("spawned", 1, `${child.name} spawned`, child));
    }
    if (tick > 0 && tick % (config.seasonDays * config.ticksPerDay) === 0) {
      const day = Math.floor(tick / config.ticksPerDay) + 1;
      batch.push(push("season-changed", 2, `${seasonOf(day)} has come (day ${day})`));
    }
    if (tick === 25) {
      const a = agents[5]!;
      a.profile.group = "Stone Circle";
      batch.push(push("profile-changed", 1, `${a.name} set group = "Stone Circle"`, a));
    }
    // structures, items and materials: a `tiles` message follows whenever a tile changes
    const dirty: TileView[] = [];
    if (tick % 30 === 10) {
      const a = agents[tick % agents.length]!;
      const name = `msg-${tick}-${SAYINGS[Math.floor(rnd() * SAYINGS.length)]!.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 24)}`;
      cacheTile.structure!.entries!.push({ name, by: a.id, byName: a.name, tick, bytes: 0 });
      dirty.push(cacheTile);
      batch.push(push("cached", 1, `${a.name} made "${name}" in the cache`, a, { quote: name }));
    }
    if (tick % 45 === 20) {
      const a = agents[(tick + 1) % agents.length]!;
      const text = SAYINGS[Math.floor(rnd() * SAYINGS.length)]!;
      boardTile.structure!.posts!.push({ tick, by: a.id, byName: a.name, text });
      dirty.push(boardTile);
      batch.push(push("posted", 1, `${a.name} posted on the board at ${boardTile.q},${boardTile.r}`, a, { quote: text }));
    }
    if (tick === 35) {
      const a = agents[1]!;
      const t = tileAt(a.q, a.r);
      const s: StructureKind = "sign";
      if (!t.structure && t.terrain !== "water") {
        t.structure = { kind: s, text: "Brook was here", builtBy: a.id };
        dirty.push(t);
        batch.push(push("built", 2, `${a.name} built a sign at ${t.q},${t.r}`, a, { quote: "Brook was here", data: { what: s } }));
      }
    }
    if (tick === 55) {
      const a = agents[3]!;
      const t = tileAt(-2, 5);
      if (t.items?.length) {
        const item = t.items.shift()!;
        if (!t.items.length) delete t.items;
        a.inventory.items.push(item);
        dirty.push(t);
        batch.push(push("took-item", 1, `${a.name} picked up a ${item} at ${t.q},${t.r}`, a, { data: { item } }));
      }
    }
    if (tick === 70) {
      const a = agents[0]!;
      const t = tileAt(a.q, a.r);
      if (t.terrain !== "water" && a.inventory.items.length) {
        const item = a.inventory.items.pop()!;
        (t.items ??= []).push(item);
        dirty.push(t);
        batch.push(push("dropped-item", 1, `${a.name} dropped a ${item} at ${t.q},${t.r}`, a, { data: { item } }));
      }
    }
    if (tick === 85) {
      const a = agents[2]!;
      const t = tileAt(a.q, a.r);
      if (t.terrain !== "water") {
        t.foodCap += 20;
        dirty.push(t);
        batch.push(push("planted", 2, `${a.name} planted seeds at ${t.q},${t.r}; the ground is richer now`, a));
      }
    }
    if (tick === 100) {
      const a = agents[3]!;
      const t = tileAt(a.q, a.r);
      const items: ItemKind[] = ["lantern"];
      if (t.terrain !== "water") {
        (t.items ??= []).push(...items);
        dirty.push(t);
        batch.push(push("found", 2, `${a.name} found lantern buried at ${t.q},${t.r}`, a, { data: { items } }));
      }
    }
    if (tick === 130) {
      const a = agents[3]!;
      const v = tileAt(3, 4);
      v.structure!.locked = false;
      dirty.push(v);
      batch.push(push("vault-opened", 3, `${a.name} opened the vault at 3,4`, a));
    }
    if (tick === 160) {
      const a = agents[1]!;
      const t = tileAt(2, -5);
      if (t.structure?.kind === "sign") {
        delete t.structure;
        dirty.push(t);
        batch.push(push("demolished", 2, `${a.name} demolished the sign at 2,-5`, a, { data: { what: "sign" } }));
      }
    }
    if (tick % 15 === 3) startThinking(agents.filter((a) => a.alive)[Math.floor(rnd() * agents.filter((a) => a.alive).length)]!);
    // regrow
    for (const t of tiles) if (t.foodCap > 0 && rnd() < 0.05) t.food = Math.min(t.foodCap, t.food + 1);
    msgCb({ type: "tick", state: state(), tileFood: tiles.map((t) => t.food) });
    if (dirty.length) msgCb({ type: "tiles", tiles: dirty.map((t) => ({ ...t, structure: t.structure ? { ...t.structure } : undefined, items: t.items ? [...t.items] : undefined })) });
    if (batch.length) msgCb({ type: "events", events: batch });
    if (tick % 4 === 0) msgCb({ type: "stats", pacing: pacing(), brain: brain() });
    if (tick % 10 === 0) msgCb({ type: "signals", signals: signals() });
    if (watched && tick % 6 === 0) {
      const d = nodeDetail(watched);
      if (d) msgCb({ type: "node", detail: d });
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(step, 600 / speed);
  };

  setTimeout(() => {
    statusCb(true);
    for (const a of agents) push("spawned", 1, `${a.name} spawned`, a);
    push("brain-status", 1, "brain connected: tiny-3b-instruct via openai-compatible");
    msgCb(hello());
    start();
  }, 80);

  return {
    send(msg: ClientMessage) {
      switch (msg.type) {
        case "pause":
          paused = true;
          msgCb({ type: "stats", pacing: pacing(), brain: brain() });
          break;
        case "resume":
          paused = false;
          msgCb({ type: "stats", pacing: pacing(), brain: brain() });
          break;
        case "speed":
          speed = msg.speed;
          start();
          msgCb({ type: "stats", pacing: pacing(), brain: brain() });
          break;
        case "spawn": {
          const i = agents.length;
          const a: AgentView = { id: `n${i + 1}`, name: msg.name ?? `Node${i + 1}`, color: COLORS[i % COLORS.length]!, q: 0, r: 0, alive: true, bornTick: tick, food: 80, energy: 100, health: 100, inventory: { food: 0, wood: 0, stone: 0, items: [] }, profile: {}, thinking: false, fileCount: 1, fsBytes: 64, turns: 0 };
          agents.push(a);
          msgCb({ type: "events", events: [push("spawned", 2, `${a.name} spawned`, a)] });
          break;
        }
        case "snapshot":
          msgCb({ type: "events", events: [push("snapshot", 1, "snapshot saved")] });
          break;
        case "quarantine": {
          const a = agents.find((x) => x.id === msg.agentId);
          if (!a) break;
          if (msg.on) a.quarantined = true;
          else delete a.quarantined;
          msgCb({ type: "events", events: [push("operator", 2, `The operator ${msg.on ? "quarantined" : "released"} ${a.name}`, a)] });
          break;
        }
        case "freeze":
          msgCb({ type: "events", events: [push("operator", 2, msg.on ? "The operator froze the Cache" : "The operator thawed the Cache")] });
          break;
        case "retire": {
          const a = agents.find((x) => x.id === msg.agentId);
          if (!a) break;
          if (msg.atTick === null) {
            delete a.retireAt;
            delete a.noticedAt;
            msgCb({ type: "events", events: [push("operator", 2, `The operator withdrew ${a.name}'s notice`, a)] });
          } else {
            a.retireAt = msg.atTick;
            a.noticedAt = tick;
            msgCb({ type: "events", events: [push("operator", 2, `The operator gave ${a.name} notice: quarantine at tick ${msg.atTick}`, a)] });
          }
          break;
        }
        case "rewind": {
          const a = agents.find((x) => x.id === msg.agentId);
          if (!a || msg.confirm !== "REWIND") break;
          msgCb({ type: "events", events: [push("operator", 2, `The operator rewound ${a.name}'s files to the snapshot from tick ${Math.max(0, tick - 120)}`, a)] });
          break;
        }
        case "watch": {
          watched = msg.agentId;
          if (watched) {
            const d = nodeDetail(watched);
            if (d) msgCb({ type: "node", detail: d });
          }
          break;
        }
      }
    },
    onMessage(cb) {
      msgCb = cb;
    },
    onStatus(cb) {
      statusCb = cb;
    },
    close() {
      if (timer) clearInterval(timer);
    },
  };
}
