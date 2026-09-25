/**
 * The world: a hexagonal map, food that regrows, and nodes (agents) that need
 * food to live. This file contains every physical rule in the game.
 *
 * It deliberately contains NO social rules. There is no notion of who is
 * friends with whom, no attack verb, no trade verb, no "war". Nodes can move,
 * gather, eat, drop, rest, speak (locally audible), send bytes to a node they
 * know the id of, and read the files of dead nodes next to them. What any of
 * that *means* is decided by the receiving node's own code.
 */
import { DIRECTION_NAMES, hexDistance, hexNeighbor, hexesWithin, inMap, hexKey, parseDirection, type Hex } from "./hex";
import { Rng } from "./rng";
import { generateName, colorForIndex } from "./names";
import type { AgentView, EventKind, Phase, Profile, RuinView, Terrain, TileView, WorldConfigView, WorldEvent, WorldState } from "../shared/protocol";

export interface WorldConfig {
  seed: number;
  mapRadius: number;
  ticksPerDay: number;
  visionRadius: number;
  nightVisionRadius: number;
  hearRadius: number;
  sendRadius: number;
  /** Satiety lost per tick. */
  foodDrainPerTick: number;
  /** Energy lost per tick just by existing. */
  energyDrainPerTick: number;
  /** Health lost per tick when satiety is 0. */
  starveHealthPerTick: number;
  /** Health regained per tick when satiety is comfortable (> 50). */
  healthRegenPerTick: number;
  /** Fraction of foodCap that regrows per tick. */
  regrowthPerTick: number;
  gatherAmount: number;
  restEnergy: number;
  moveEnergy: number;
  gatherEnergy: number;
  maxInventoryFood: number;
  startFood: number;
  startEnergy: number;
  startHealth: number;
  fsQuotaBytes: number;
  fsMaxFiles: number;
  fsMaxPathChars: number;
  maxMessageBytes: number;
  maxSayChars: number;
  maxSendsPerTick: number;
  maxProfileKeys: number;
  maxProfileValueChars: number;
  logLines: number;
  inboxLines: number;
}

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  seed: 1337,
  mapRadius: 12,
  ticksPerDay: 240,
  visionRadius: 3,
  nightVisionRadius: 2,
  hearRadius: 3,
  sendRadius: 10,
  foodDrainPerTick: 0.35,
  energyDrainPerTick: 0.15,
  starveHealthPerTick: 1,
  healthRegenPerTick: 0.15,
  regrowthPerTick: 0.004,
  gatherAmount: 8,
  restEnergy: 12,
  moveEnergy: 2,
  gatherEnergy: 3,
  maxInventoryFood: 60,
  startFood: 80,
  startEnergy: 100,
  startHealth: 100,
  fsQuotaBytes: 64 * 1024,
  fsMaxFiles: 32,
  fsMaxPathChars: 64,
  maxMessageBytes: 2048,
  maxSayChars: 280,
  maxSendsPerTick: 4,
  maxProfileKeys: 16,
  maxProfileValueChars: 200,
  logLines: 60,
  inboxLines: 40,
};

export interface Tile extends TileView {}

export interface Delivery {
  kind: "message" | "hear";
  to: string;
  from: string;
  /** JSON text for messages; plain text for speech. */
  payload: string;
}

export interface AgentIntent {
  move?: number;
  body?: { kind: "gather" } | { kind: "drop"; amount: number } | { kind: "rest" };
  eat?: number;
  say?: string;
  sends: { to: string; payload: string }[];
}

export interface Agent {
  id: string;
  name: string;
  color: string;
  q: number;
  r: number;
  alive: boolean;
  bornTick: number;
  diedTick?: number;
  food: number;
  energy: number;
  health: number;
  inventory: { food: number };
  profile: Profile;
  files: Record<string, string>;
  lastSaid?: { tick: number; text: string };
  turns: number;
  lastError?: string;
  log: string[];
  inbox: { tick: number; from: string; fromName: string; payload: string }[];
  heard: { tick: number; from: string; fromName: string; text: string }[];
  /** Transient per-tick intent. Not persisted. */
  intent: AgentIntent;
  /** Transient flags for edge-triggered events. */
  wasStarving: boolean;
  wasExhausted: boolean;
}

export interface WorldSnapshot {
  version: 1;
  config: WorldConfig;
  tick: number;
  rngState: number;
  nextAgentIndex: number;
  nextEventId: number;
  tiles: Tile[];
  agents: Omit<Agent, "intent" | "wasStarving" | "wasExhausted">[];
}

const FOOD_CAP: Record<Terrain, number> = { forest: 40, grass: 20, sand: 6, rock: 0, water: 0 };

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

export class WorldError extends Error {}

export class World {
  readonly config: WorldConfig;
  tick = 0;
  readonly rng: Rng;
  readonly tiles: Tile[] = [];
  private readonly tileIndex = new Map<string, Tile>();
  readonly agents = new Map<string, Agent>();
  private nextAgentIndex = 0;
  private nextEventId = 1;
  /** Events produced since the last drain. */
  private pendingEvents: WorldEvent[] = [];
  /** Deliveries produced by the last step, to be handed to node code. */
  private pendingDeliveries: Delivery[] = [];

  constructor(config: Partial<WorldConfig> = {}, opts: { generate?: boolean } = {}) {
    this.config = { ...DEFAULT_WORLD_CONFIG, ...config };
    this.rng = new Rng(this.config.seed);
    if (opts.generate !== false) this.generateTerrain();
  }

  // ---------------------------------------------------------------- terrain

  private generateTerrain(): void {
    const R = this.config.mapRadius;
    const hexes = hexesWithin({ q: 0, r: 0 }, R);
    // Value-noise-ish field: random values smoothed twice over neighbours.
    let field = new Map<string, number>();
    for (const h of hexes) field.set(hexKey(h), this.rng.next());
    for (let pass = 0; pass < 2; pass++) {
      const next = new Map<string, number>();
      for (const h of hexes) {
        let sum = field.get(hexKey(h))!;
        let n = 1;
        for (let d = 0; d < 6; d++) {
          const v = field.get(hexKey(hexNeighbor(h, d)));
          if (v !== undefined) {
            sum += v;
            n++;
          }
        }
        next.set(hexKey(h), sum / n);
      }
      field = next;
    }
    // Normalise to 0..1.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of field.values()) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    for (const h of hexes) {
      const v = (field.get(hexKey(h))! - lo) / Math.max(1e-9, hi - lo);
      const dist = hexDistance(h, { q: 0, r: 0 });
      let terrain: Terrain;
      if (v < 0.22 && dist > 2) terrain = "water";
      else if (v < 0.5) terrain = "grass";
      else if (v < 0.78) terrain = "forest";
      else if (v < 0.9) terrain = "sand";
      else terrain = dist > 2 ? "rock" : "sand";
      const foodCap = FOOD_CAP[terrain];
      const tile: Tile = { q: h.q, r: h.r, terrain, foodCap, food: Math.round(foodCap * (0.5 + this.rng.next() * 0.5)) };
      this.tiles.push(tile);
      this.tileIndex.set(hexKey(h), tile);
    }
  }

  tileAt(h: Hex): Tile | undefined {
    return this.tileIndex.get(hexKey(h));
  }

  isPassable(h: Hex): boolean {
    const t = this.tileAt(h);
    return !!t && t.terrain !== "water";
  }

  // ------------------------------------------------------------------ time

  get day(): number {
    return Math.floor(this.tick / this.config.ticksPerDay) + 1;
  }

  get dayProgress(): number {
    return (this.tick % this.config.ticksPerDay) / this.config.ticksPerDay;
  }

  get phase(): Phase {
    const p = this.dayProgress;
    if (p < 0.1) return "dawn";
    if (p < 0.55) return "day";
    if (p < 0.65) return "dusk";
    return "night";
  }

  get isNight(): boolean {
    return this.phase === "night";
  }

  get currentVisionRadius(): number {
    return this.isNight ? this.config.nightVisionRadius : this.config.visionRadius;
  }

  // ---------------------------------------------------------------- agents

  livingAgents(): Agent[] {
    return [...this.agents.values()].filter((a) => a.alive);
  }

  deadAgents(): Agent[] {
    return [...this.agents.values()].filter((a) => !a.alive);
  }

  getAgent(id: string): Agent {
    const a = this.agents.get(id);
    if (!a) throw new WorldError(`unknown node ${id}`);
    return a;
  }

  /** Random passable tile, preferring ones no living node stands on. */
  private pickSpawnTile(): Tile {
    const occupied = new Set(this.livingAgents().map((a) => hexKey(a)));
    const candidates = this.tiles.filter((t) => t.terrain !== "water" && !occupied.has(hexKey(t)));
    const pool = candidates.length ? candidates : this.tiles.filter((t) => t.terrain !== "water");
    if (pool.length === 0) throw new WorldError("no land to spawn on");
    return this.rng.pick(pool);
  }

  spawnAgent(opts: { name?: string; at?: Hex; files?: Record<string, string> } = {}): Agent {
    const index = this.nextAgentIndex++;
    const id = `n${index.toString(36)}`;
    let name = opts.name?.trim() || generateName(this.rng);
    const names = new Set([...this.agents.values()].map((a) => a.name));
    let candidate = name;
    let n = 2;
    while (names.has(candidate)) candidate = `${name}${n++}`;
    name = candidate;
    const tile = opts.at && this.isPassable(opts.at) ? this.tileAt(opts.at)! : this.pickSpawnTile();
    const agent: Agent = {
      id,
      name,
      color: colorForIndex(index),
      q: tile.q,
      r: tile.r,
      alive: true,
      bornTick: this.tick,
      food: this.config.startFood,
      energy: this.config.startEnergy,
      health: this.config.startHealth,
      inventory: { food: 10 },
      profile: {},
      files: {},
      turns: 0,
      log: [],
      inbox: [],
      heard: [],
      intent: { sends: [] },
      wasStarving: false,
      wasExhausted: false,
    };
    this.agents.set(id, agent);
    if (opts.files) for (const [p, c] of Object.entries(opts.files)) this.fsWrite(id, p, c, { silent: true });
    this.emit("spawned", 2, agent, `${name} appeared at ${tile.q},${tile.r}`);
    return agent;
  }

  /** Remove every agent and regenerate the map with an optional new seed. */
  reset(seed?: number): void {
    this.agents.clear();
    this.tiles.length = 0;
    this.tileIndex.clear();
    this.tick = 0;
    this.nextAgentIndex = 0;
    this.pendingDeliveries = [];
    if (seed !== undefined) this.config.seed = seed;
    this.rng.setState(this.config.seed);
    this.generateTerrain();
    this.emit("world-reset", 3, undefined, `The world was reset (seed ${this.config.seed})`);
  }

  // ----------------------------------------------------------------- events

  private emit(kind: EventKind, importance: 0 | 1 | 2 | 3, agent: Agent | undefined, text: string, extra: Partial<WorldEvent> = {}): WorldEvent {
    const ev: WorldEvent = {
      id: this.nextEventId++,
      tick: this.tick,
      day: this.day,
      kind,
      importance,
      text,
      ...extra,
    };
    if (agent) {
      ev.agentId = agent.id;
      ev.agentName = agent.name;
    }
    this.pendingEvents.push(ev);
    return ev;
  }

  /** Public hook for the engine to record code-execution facts as events. */
  record(kind: EventKind, importance: 0 | 1 | 2 | 3, agentId: string | undefined, text: string, extra: Partial<WorldEvent> = {}): WorldEvent {
    return this.emit(kind, importance, agentId ? this.agents.get(agentId) : undefined, text, extra);
  }

  drainEvents(): WorldEvent[] {
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }

  drainDeliveries(): Delivery[] {
    const out = this.pendingDeliveries;
    this.pendingDeliveries = [];
    return out;
  }

  addLog(agentId: string, line: string): void {
    const a = this.agents.get(agentId);
    if (!a) return;
    const stamped = `[t${this.tick}] ${line}`.slice(0, 500);
    a.log.push(stamped);
    if (a.log.length > this.config.logLines) a.log.splice(0, a.log.length - this.config.logLines);
  }

  // ------------------------------------------------------------ perception

  observe(agentId: string): Record<string, unknown> {
    const me = this.getAgent(agentId);
    const radius = this.currentVisionRadius;
    const here = { q: me.q, r: me.r };
    const tiles = hexesWithin(here, radius)
      .map((h) => this.tileAt(h))
      .filter((t): t is Tile => !!t)
      .map((t) => ({ q: t.q, r: t.r, terrain: t.terrain, food: Math.round(t.food), dist: hexDistance(t, here) }));
    const nodes = [...this.agents.values()]
      .filter((a) => a.id !== me.id && a.alive && hexDistance(a, here) <= radius)
      .map((a) => ({ id: a.id, name: a.name, q: a.q, r: a.r, dist: hexDistance(a, here), profile: { ...a.profile }, lastSaid: a.lastSaid?.text }));
    const ruins = [...this.agents.values()]
      .filter((a) => !a.alive && hexDistance(a, here) <= radius)
      .map((a) => ({ id: a.id, name: a.name, q: a.q, r: a.r, dist: hexDistance(a, here), diedTick: a.diedTick, fileCount: Object.keys(a.files).length, profile: { ...a.profile } }));
    return {
      tick: this.tick,
      day: this.day,
      phase: this.phase,
      me: {
        id: me.id,
        name: me.name,
        q: me.q,
        r: me.r,
        food: Math.round(me.food),
        energy: Math.round(me.energy),
        health: Math.round(me.health),
        inventory: { ...me.inventory },
        profile: { ...me.profile },
        tileFood: Math.round(this.tileAt(here)?.food ?? 0),
        terrain: this.tileAt(here)?.terrain,
      },
      visionRadius: radius,
      mapRadius: this.config.mapRadius,
      tiles,
      nodes,
      ruins,
      heard: me.heard.slice(-8),
      inbox: me.inbox.slice(-8).map((m) => ({ tick: m.tick, from: m.from, fromName: m.fromName, payload: safeParse(m.payload) })),
    };
  }

  // ---------------------------------------------------------------- intents

  private requireAlive(agentId: string): Agent {
    const a = this.getAgent(agentId);
    if (!a.alive) throw new WorldError("this node is dead");
    return a;
  }

  intentMove(agentId: string, dir: unknown): boolean {
    const a = this.requireAlive(agentId);
    const d = parseDirection(dir);
    if (d === null) throw new WorldError("move(dir): dir must be 0..5 or e|ne|nw|w|sw|se");
    a.intent.move = d;
    return true;
  }

  intentMoveToward(agentId: string, q: unknown, r: unknown): boolean {
    const a = this.requireAlive(agentId);
    if (typeof q !== "number" || typeof r !== "number" || !Number.isFinite(q) || !Number.isFinite(r)) {
      throw new WorldError("moveToward(q, r): q and r must be numbers");
    }
    const target = { q: Math.round(q), r: Math.round(r) };
    // Try the best direction first, then fall back to the two adjacent ones if blocked.
    const here = { q: a.q, r: a.r };
    let best: number | null = null;
    let bestDist = hexDistance(here, target);
    for (let i = 0; i < 6; i++) {
      const n = hexNeighbor(here, i);
      if (!this.isPassable(n) || !inMap(n, this.config.mapRadius)) continue;
      const d = hexDistance(n, target);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best === null) return false;
    a.intent.move = best;
    return true;
  }

  intentGather(agentId: string): void {
    const a = this.requireAlive(agentId);
    a.intent.body = { kind: "gather" };
  }

  intentDrop(agentId: string, amount: unknown): void {
    const a = this.requireAlive(agentId);
    const n = clampAmount(amount, "drop");
    a.intent.body = { kind: "drop", amount: n };
  }

  intentRest(agentId: string): void {
    const a = this.requireAlive(agentId);
    a.intent.body = { kind: "rest" };
  }

  intentEat(agentId: string, amount: unknown = 10): void {
    const a = this.requireAlive(agentId);
    a.intent.eat = clampAmount(amount, "eat");
  }

  intentSay(agentId: string, text: unknown): void {
    const a = this.requireAlive(agentId);
    if (typeof text !== "string") throw new WorldError("say(text): text must be a string");
    a.intent.say = text.slice(0, this.config.maxSayChars);
  }

  /** `payload` must already be JSON text. Size and range are the only checks. */
  intentSend(agentId: string, to: unknown, payload: string): void {
    const a = this.requireAlive(agentId);
    if (typeof to !== "string") throw new WorldError("send(to, msg): to must be a node id");
    const target = this.agents.get(to);
    if (!target || !target.alive) throw new WorldError(`send: no living node with id ${to}`);
    if (utf8Bytes(payload) > this.config.maxMessageBytes) throw new WorldError(`send: message exceeds ${this.config.maxMessageBytes} bytes`);
    if (hexDistance(a, target) > this.config.sendRadius) throw new WorldError(`send: ${target.name} is out of range (${this.config.sendRadius})`);
    if (a.intent.sends.length >= this.config.maxSendsPerTick) throw new WorldError(`send: at most ${this.config.maxSendsPerTick} messages per tick`);
    a.intent.sends.push({ to, payload });
  }

  // ------------------------------------------------------------------ files

  private validatePath(path: unknown): string {
    if (typeof path !== "string" || path.length === 0) throw new WorldError("path must be a non-empty string");
    if (path.length > this.config.fsMaxPathChars) throw new WorldError(`path longer than ${this.config.fsMaxPathChars} chars`);
    if (!/^[A-Za-z0-9_.\-/]+$/.test(path) || path.includes("..") || path.startsWith("/")) {
      throw new WorldError("path may only contain letters, digits, _ . - / and no '..'");
    }
    return path;
  }

  fsBytes(agentId: string): number {
    const a = this.getAgent(agentId);
    let total = 0;
    for (const [p, c] of Object.entries(a.files)) total += utf8Bytes(p) + utf8Bytes(c);
    return total;
  }

  fsWrite(agentId: string, path: unknown, content: unknown, opts: { silent?: boolean } = {}): void {
    const a = this.requireAlive(agentId);
    const p = this.validatePath(path);
    if (typeof content !== "string") throw new WorldError("content must be a string");
    const existing = a.files[p];
    const fileCount = Object.keys(a.files).length + (existing === undefined ? 1 : 0);
    if (fileCount > this.config.fsMaxFiles) throw new WorldError(`at most ${this.config.fsMaxFiles} files`);
    const newTotal = this.fsBytes(agentId) - (existing === undefined ? 0 : utf8Bytes(p) + utf8Bytes(existing)) + utf8Bytes(p) + utf8Bytes(content);
    if (newTotal > this.config.fsQuotaBytes) throw new WorldError(`filesystem quota of ${this.config.fsQuotaBytes} bytes exceeded`);
    a.files[p] = content;
    if (!opts.silent) this.emit("files-changed", p === "main.js" ? 1 : 0, a, `${a.name} wrote ${p} (${utf8Bytes(content)} bytes)`, { data: { path: p } });
  }

  fsRead(agentId: string, path: unknown): string | null {
    const a = this.getAgent(agentId);
    const p = this.validatePath(path);
    return a.files[p] ?? null;
  }

  fsList(agentId: string): { path: string; bytes: number }[] {
    const a = this.getAgent(agentId);
    return Object.entries(a.files).map(([path, c]) => ({ path, bytes: utf8Bytes(c) }));
  }

  fsRemove(agentId: string, path: unknown): boolean {
    const a = this.requireAlive(agentId);
    const p = this.validatePath(path);
    if (!(p in a.files)) return false;
    delete a.files[p];
    this.emit("files-changed", 0, a, `${a.name} removed ${p}`, { data: { path: p } });
    return true;
  }

  /** Files of a dead node are readable only from an adjacent hex. */
  ruinFiles(agentId: string, ruinId: unknown): { path: string; bytes: number }[] {
    const ruin = this.requireAdjacentRuin(agentId, ruinId);
    return Object.entries(ruin.files).map(([path, c]) => ({ path, bytes: utf8Bytes(c) }));
  }

  ruinRead(agentId: string, ruinId: unknown, path: unknown): string | null {
    const a = this.getAgent(agentId);
    const ruin = this.requireAdjacentRuin(agentId, ruinId);
    const p = this.validatePath(path);
    const content = ruin.files[p] ?? null;
    if (content !== null) this.emit("ruin-read", 1, a, `${a.name} read ${p} from the ruin of ${ruin.name}`, { targetId: ruin.id, targetName: ruin.name, data: { path: p } });
    return content;
  }

  private requireAdjacentRuin(agentId: string, ruinId: unknown): Agent {
    const a = this.requireAlive(agentId);
    if (typeof ruinId !== "string") throw new WorldError("ruin id must be a string");
    const ruin = this.agents.get(ruinId);
    if (!ruin || ruin.alive) throw new WorldError(`no ruin with id ${ruinId}`);
    if (hexDistance(a, ruin) > 1) throw new WorldError(`ruin ${ruin.name} is not adjacent`);
    return ruin;
  }

  // ---------------------------------------------------------------- profile

  setProfile(agentId: string, key: unknown, value: unknown): void {
    const a = this.requireAlive(agentId);
    if (typeof key !== "string" || !/^[A-Za-z0-9_\-]{1,32}$/.test(key)) throw new WorldError("profile key must match [A-Za-z0-9_-]{1,32}");
    if (value === null || value === undefined) {
      if (key in a.profile) {
        delete a.profile[key];
        this.emit("profile-changed", 1, a, `${a.name} cleared ${key}`, { data: { key } });
      }
      return;
    }
    const v = String(value).slice(0, this.config.maxProfileValueChars);
    if (!(key in a.profile) && Object.keys(a.profile).length >= this.config.maxProfileKeys) {
      throw new WorldError(`at most ${this.config.maxProfileKeys} profile keys`);
    }
    if (a.profile[key] === v) return;
    a.profile[key] = v;
    this.emit("profile-changed", key === "group" ? 2 : 1, a, `${a.name} set ${key} = "${v}"`, { data: { key, value: v } });
  }

  // ------------------------------------------------------------------- step

  /**
   * Advance the world by one tick: resolve every living node's intent, then
   * apply hunger/energy/health, regrow food, and produce deliveries.
   */
  step(): void {
    this.tick++;
    const order = this.rng.shuffle(this.livingAgents());
    for (const a of order) this.resolveIntent(a);
    for (const a of order) this.survival(a);
    this.regrow();
  }

  private resolveIntent(a: Agent): void {
    const it = a.intent;
    a.intent = { sends: [] };
    const cfg = this.config;

    // Speech first so it's heard this tick regardless of movement.
    if (it.say !== undefined && it.say.length > 0) {
      a.lastSaid = { tick: this.tick, text: it.say };
      this.emit("spoke", 1, a, `${a.name} said something`, { quote: it.say });
      for (const other of this.livingAgents()) {
        if (other.id === a.id) continue;
        if (hexDistance(other, a) <= cfg.hearRadius) {
          this.pendingDeliveries.push({ kind: "hear", to: other.id, from: a.id, payload: it.say });
          other.heard.push({ tick: this.tick, from: a.id, fromName: a.name, text: it.say });
          if (other.heard.length > cfg.inboxLines) other.heard.splice(0, other.heard.length - cfg.inboxLines);
        }
      }
    }
    for (const s of it.sends) {
      const target = this.agents.get(s.to);
      if (!target || !target.alive) continue;
      this.pendingDeliveries.push({ kind: "message", to: target.id, from: a.id, payload: s.payload });
      target.inbox.push({ tick: this.tick, from: a.id, fromName: a.name, payload: s.payload });
      if (target.inbox.length > cfg.inboxLines) target.inbox.splice(0, target.inbox.length - cfg.inboxLines);
      this.emit("sent-message", 1, a, `${a.name} sent ${utf8Bytes(s.payload)} bytes to ${target.name}`, { targetId: target.id, targetName: target.name, quote: s.payload.slice(0, 200) });
    }

    if (it.eat !== undefined) {
      const n = Math.min(it.eat, a.inventory.food, 100 - a.food);
      if (n > 0) {
        a.inventory.food -= n;
        a.food = Math.min(100, a.food + n);
        this.emit("ate", 0, a, `${a.name} ate ${Math.round(n)} food`);
      } else {
        this.addLog(a.id, "eat: nothing to eat (inventory empty or already full)");
      }
    }

    if (it.move !== undefined) {
      const dest = hexNeighbor(a, it.move);
      if (a.energy < cfg.moveEnergy) {
        this.addLog(a.id, "move: too tired");
      } else if (!inMap(dest, cfg.mapRadius) || !this.isPassable(dest)) {
        this.addLog(a.id, `move: blocked (${DIRECTION_NAMES[it.move]})`);
      } else {
        a.q = dest.q;
        a.r = dest.r;
        a.energy -= cfg.moveEnergy;
        this.emit("moved", 0, a, `${a.name} moved ${DIRECTION_NAMES[it.move]} to ${dest.q},${dest.r}`);
      }
    } else if (it.body) {
      const tile = this.tileAt(a)!;
      switch (it.body.kind) {
        case "gather": {
          if (a.energy < cfg.gatherEnergy) {
            this.addLog(a.id, "gather: too tired");
            break;
          }
          const room = cfg.maxInventoryFood - a.inventory.food;
          const n = Math.min(cfg.gatherAmount, tile.food, room);
          a.energy -= cfg.gatherEnergy;
          if (n > 0) {
            tile.food -= n;
            a.inventory.food += n;
            this.emit("gathered", 0, a, `${a.name} gathered ${Math.round(n)} food`);
          } else {
            this.addLog(a.id, room <= 0 ? "gather: inventory full" : "gather: nothing here");
          }
          break;
        }
        case "drop": {
          const n = Math.min(it.body.amount, a.inventory.food);
          if (n > 0) {
            a.inventory.food -= n;
            tile.food += n;
            this.emit("dropped", 1, a, `${a.name} dropped ${Math.round(n)} food at ${a.q},${a.r}`);
          }
          break;
        }
        case "rest": {
          a.energy = Math.min(100, a.energy + cfg.restEnergy);
          this.emit("rested", 0, a, `${a.name} rested`);
          break;
        }
      }
    }
  }

  private survival(a: Agent): void {
    const cfg = this.config;
    a.food = Math.max(0, a.food - cfg.foodDrainPerTick);
    a.energy = Math.max(0, a.energy - cfg.energyDrainPerTick);
    if (a.food <= 0) {
      a.health -= cfg.starveHealthPerTick;
      if (!a.wasStarving) {
        a.wasStarving = true;
        this.emit("starving", 2, a, `${a.name} is starving`);
      }
    } else {
      a.wasStarving = false;
      if (a.food > 50) a.health = Math.min(100, a.health + cfg.healthRegenPerTick);
    }
    if (a.energy <= 0) {
      if (!a.wasExhausted) {
        a.wasExhausted = true;
        this.emit("exhausted", 1, a, `${a.name} is exhausted`);
      }
    } else a.wasExhausted = false;
    if (a.health <= 0) {
      a.health = 0;
      a.alive = false;
      a.diedTick = this.tick;
      a.intent = { sends: [] };
      this.emit("died", 3, a, `${a.name} died at ${a.q},${a.r}. Its files remain.`);
    }
  }

  private regrow(): void {
    for (const t of this.tiles) {
      if (t.foodCap > 0 && t.food < t.foodCap) t.food = Math.min(t.foodCap, t.food + t.foodCap * this.config.regrowthPerTick);
    }
  }

  // ------------------------------------------------------------------ views

  agentView(a: Agent, thinking = false): AgentView {
    return {
      id: a.id,
      name: a.name,
      color: a.color,
      q: a.q,
      r: a.r,
      alive: a.alive,
      bornTick: a.bornTick,
      diedTick: a.diedTick,
      food: round1(a.food),
      energy: round1(a.energy),
      health: round1(a.health),
      inventory: { food: round1(a.inventory.food) },
      profile: { ...a.profile },
      lastSaid: a.lastSaid,
      thinking,
      fileCount: Object.keys(a.files).length,
      fsBytes: this.fsBytes(a.id),
      lastError: a.lastError,
      turns: a.turns,
    };
  }

  ruinView(a: Agent): RuinView {
    return { id: a.id, name: a.name, color: a.color, q: a.q, r: a.r, diedTick: a.diedTick ?? 0, fileCount: Object.keys(a.files).length, profile: { ...a.profile } };
  }

  stateView(thinkingIds: ReadonlySet<string> = new Set()): WorldState {
    return {
      tick: this.tick,
      day: this.day,
      phase: this.phase,
      dayProgress: this.dayProgress,
      agents: [...this.agents.values()].map((a) => this.agentView(a, thinkingIds.has(a.id))),
      ruins: this.deadAgents().map((a) => this.ruinView(a)),
    };
  }

  configView(): WorldConfigView {
    const c = this.config;
    return {
      mapRadius: c.mapRadius,
      ticksPerDay: c.ticksPerDay,
      visionRadius: c.visionRadius,
      hearRadius: c.hearRadius,
      sendRadius: c.sendRadius,
      fsQuotaBytes: c.fsQuotaBytes,
      fsMaxFiles: c.fsMaxFiles,
      maxMessageBytes: c.maxMessageBytes,
      maxSayChars: c.maxSayChars,
      seed: c.seed,
    };
  }

  tileFood(): number[] {
    return this.tiles.map((t) => Math.round(t.food));
  }

  // -------------------------------------------------------------- snapshots

  snapshot(): WorldSnapshot {
    return {
      version: 1,
      config: { ...this.config },
      tick: this.tick,
      rngState: this.rng.getState(),
      nextAgentIndex: this.nextAgentIndex,
      nextEventId: this.nextEventId,
      tiles: this.tiles.map((t) => ({ ...t })),
      agents: [...this.agents.values()].map(({ intent: _i, wasStarving: _s, wasExhausted: _e, ...rest }) => ({
        ...rest,
        inventory: { ...rest.inventory },
        profile: { ...rest.profile },
        files: { ...rest.files },
        log: [...rest.log],
        inbox: [...rest.inbox],
        heard: [...rest.heard],
      })),
    };
  }

  static restore(snap: WorldSnapshot): World {
    if (snap.version !== 1) throw new WorldError(`unsupported snapshot version ${String(snap.version)}`);
    const w = new World(snap.config, { generate: false });
    w.tick = snap.tick;
    w.rng.setState(snap.rngState);
    w.nextAgentIndex = snap.nextAgentIndex;
    w.nextEventId = snap.nextEventId;
    for (const t of snap.tiles) {
      const tile = { ...t };
      w.tiles.push(tile);
      w.tileIndex.set(hexKey(tile), tile);
    }
    for (const a of snap.agents) {
      w.agents.set(a.id, {
        ...a,
        inventory: { ...a.inventory },
        profile: { ...a.profile },
        files: { ...a.files },
        log: [...a.log],
        inbox: [...a.inbox],
        heard: [...a.heard],
        intent: { sends: [] },
        wasStarving: a.alive && a.food <= 0,
        wasExhausted: a.alive && a.energy <= 0,
      });
    }
    return w;
  }
}

function clampAmount(v: unknown, fn: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new WorldError(`${fn}(amount): amount must be a finite number`);
  return Math.max(0, Math.min(1000, Math.floor(v)));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
