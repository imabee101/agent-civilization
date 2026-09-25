/**
 * The world: a hexagonal map, food that regrows, materials, a few physical
 * structures, and nodes (agents) that need food to live. This file contains
 * every physical rule in the game.
 *
 * It deliberately contains NO social rules. There is no notion of who is
 * friends with whom, no attack verb, no trade verb, no "war". Nodes can move,
 * gather, eat, drop, rest, build, speak (locally audible), send bytes to a
 * node they know the id of, post on boards, mkdir in the shared cache, pick
 * things up, and read the files of dead nodes next to them. What any of that
 * *means* is decided by the receiving node's own code.
 */
import { DIRECTION_NAMES, hexDistance, hexNeighbor, hexesWithin, inMap, hexKey, parseDirection, type Hex } from "./hex";
import { Rng } from "./rng";
import { generateName, colorForIndex } from "./names";
import { ANCIENT_RUINS, BUILD_COSTS, DEMOLISHABLE, INITIAL_BOARD_POSTS, INITIAL_CACHE_ENTRIES, PLAQUE_TEXT } from "./features";
import type { AgentView, BoardPost, CacheEntry, EventKind, ItemKind, Phase, Profile, RuinView, StructureKind, StructureView, Terrain, TileView, WorldConfigView, WorldEvent, WorldState } from "../shared/protocol";

export interface WorldConfig {
  seed: number;
  mapRadius: number;
  ticksPerDay: number;
  visionRadius: number;
  nightVisionRadius: number;
  hearRadius: number;
  sendRadius: number;
  /** send() range for a node standing on or next to a tower. */
  towerSendRadius: number;
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
  /** Fraction of cap that regrows per tick for springs. */
  springRegrowthPerTick: number;
  /** Fraction of material cap that regrows per tick. */
  materialRegrowthPerTick: number;
  gatherAmount: number;
  gatherWoodAmount: number;
  gatherStoneAmount: number;
  restEnergy: number;
  moveEnergy: number;
  gatherEnergy: number;
  buildEnergy: number;
  demolishEnergy: number;
  maxInventoryFood: number;
  maxInventoryWood: number;
  maxInventoryStone: number;
  maxItems: number;
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
  signChars: number;
  boardMaxPosts: number;
  boardPostChars: number;
  cacheMaxEntries: number;
  cacheNameChars: number;
  cacheEntryBytes: number;
  /** Radius around the Cache in which new nodes spawn. */
  spawnRadius: number;
  /** Number of springs / towers / boards placed at generation. */
  springs: number;
  towers: number;
  boards: number;
  /** Place ancient ruins and hidden items at generation. */
  features: boolean;
}

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  seed: 1337,
  mapRadius: 12,
  ticksPerDay: 240,
  visionRadius: 3,
  nightVisionRadius: 2,
  hearRadius: 3,
  sendRadius: 10,
  towerSendRadius: 40,
  foodDrainPerTick: 0.35,
  energyDrainPerTick: 0.15,
  starveHealthPerTick: 1,
  healthRegenPerTick: 0.15,
  regrowthPerTick: 0.004,
  springRegrowthPerTick: 0.03,
  materialRegrowthPerTick: 0.002,
  gatherAmount: 8,
  gatherWoodAmount: 3,
  gatherStoneAmount: 2,
  restEnergy: 12,
  moveEnergy: 2,
  gatherEnergy: 3,
  buildEnergy: 6,
  demolishEnergy: 6,
  maxInventoryFood: 60,
  maxInventoryWood: 20,
  maxInventoryStone: 20,
  maxItems: 3,
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
  signChars: 120,
  boardMaxPosts: 40,
  boardPostChars: 240,
  cacheMaxEntries: 120,
  cacheNameChars: 64,
  cacheEntryBytes: 512,
  spawnRadius: 3,
  springs: 3,
  towers: 2,
  boards: 2,
  features: true,
};

export interface Structure {
  kind: StructureKind;
  text?: string;
  posts?: BoardPost[];
  /** Cache: name -> entry (+ content). */
  entries?: Record<string, CacheEntry & { text: string }>;
  builtBy?: string;
  locked?: boolean;
}

export interface Tile {
  q: number;
  r: number;
  terrain: Terrain;
  food: number;
  foodCap: number;
  wood: number;
  woodCap: number;
  stone: number;
  stoneCap: number;
  structure?: Structure;
  items: ItemKind[];
  /** Items nobody has found yet. Revealed when a node stands here. */
  hidden: ItemKind[];
}

export interface Delivery {
  kind: "message" | "hear";
  to: string;
  from: string;
  /** JSON text for messages; plain text for speech. */
  payload: string;
}

export interface AgentIntent {
  move?: number;
  body?: { kind: "gather"; what: "food" | "wood" | "stone" } | { kind: "drop"; amount: number } | { kind: "rest" } | { kind: "build"; what: StructureKind; text?: string } | { kind: "demolish" } | { kind: "plant" };
  eat?: number;
  say?: string;
  sends: { to: string; payload: string }[];
}

export interface Inventory {
  food: number;
  wood: number;
  stone: number;
  items: ItemKind[];
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
  inventory: Inventory;
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
  version: 2;
  config: WorldConfig;
  tick: number;
  rngState: number;
  nextAgentIndex: number;
  nextEventId: number;
  tiles: Tile[];
  agents: Omit<Agent, "intent" | "wasStarving" | "wasExhausted">[];
}

const FOOD_CAP: Record<Terrain, number> = { forest: 40, grass: 20, sand: 6, rock: 0, water: 0 };
const WOOD_CAP: Record<Terrain, number> = { forest: 12, grass: 2, sand: 0, rock: 0, water: 0 };
const STONE_CAP: Record<Terrain, number> = { forest: 0, grass: 0, sand: 4, rock: 12, water: 0 };

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
  /** Tiles whose structure/items/materials changed since the last drain. */
  private dirtyTiles = new Set<string>();

  constructor(config: Partial<WorldConfig> = {}, opts: { generate?: boolean } = {}) {
    this.config = { ...DEFAULT_WORLD_CONFIG, ...config };
    this.rng = new Rng(this.config.seed);
    if (opts.generate !== false) this.generate();
  }

  // ---------------------------------------------------------------- terrain

  private generate(): void {
    this.generateTerrain();
    if (this.config.features) this.placeFeatures();
  }

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
      const tile: Tile = {
        q: h.q,
        r: h.r,
        terrain,
        foodCap: FOOD_CAP[terrain],
        food: Math.round(FOOD_CAP[terrain] * (0.5 + this.rng.next() * 0.5)),
        woodCap: WOOD_CAP[terrain],
        wood: Math.round(WOOD_CAP[terrain] * (0.5 + this.rng.next() * 0.5)),
        stoneCap: STONE_CAP[terrain],
        stone: Math.round(STONE_CAP[terrain] * (0.5 + this.rng.next() * 0.5)),
        items: [],
        hidden: [],
      };
      this.tiles.push(tile);
      this.tileIndex.set(hexKey(h), tile);
    }
  }

  /** Place the Cache, plaque, springs, towers, boards, vault, ancient ruins and hidden items. All deterministic per seed. */
  private placeFeatures(): void {
    const cfg = this.config;
    const land = () => this.tiles.filter((t) => t.terrain !== "water" && !t.structure);
    const farFrom = (pts: Hex[], min: number) => (t: Tile) => pts.every((p) => hexDistance(t, p) >= min);
    const pickTile = (pred: (t: Tile) => boolean, fallback = true): Tile | undefined => {
      const pool = land().filter(pred);
      if (pool.length) return this.rng.pick(pool);
      return fallback ? this.rng.pick(land()) : undefined;
    };

    // The Cache: the land tile closest to the centre.
    const cacheTile = [...land()].sort((a, b) => hexDistance(a, { q: 0, r: 0 }) - hexDistance(b, { q: 0, r: 0 }))[0]!;
    const entries: Record<string, CacheEntry & { text: string }> = {};
    for (const e of INITIAL_CACHE_ENTRIES) entries[e.name] = { name: e.name, by: "ruin", byName: e.by, tick: 0, bytes: utf8Bytes(e.text), text: e.text };
    cacheTile.structure = { kind: "cache", entries };
    const placed: Record<string, Hex[]> = { cache: [cacheTile], plaque: [], spring: [], tower: [], board: [], vault: [] };

    // Plaque next to the Cache.
    const plaqueTile = pickTile((t) => hexDistance(t, cacheTile) === 1);
    if (plaqueTile) {
      plaqueTile.structure = { kind: "plaque", text: PLAQUE_TEXT };
      placed.plaque!.push(plaqueTile);
    }

    // Springs: spread out, not too near the Cache.
    for (let i = 0; i < cfg.springs; i++) {
      const t = pickTile((x) => x.terrain !== "rock" && farFrom([cacheTile, ...placed.spring!], Math.max(3, Math.floor(cfg.mapRadius / 2)))(x));
      if (!t) break;
      t.structure = { kind: "spring" };
      t.foodCap = 60;
      t.food = 60;
      placed.spring!.push(t);
    }
    // Towers: opposite-ish sides.
    for (let i = 0; i < cfg.towers; i++) {
      const t = pickTile(farFrom([cacheTile, ...placed.tower!], Math.max(4, Math.floor(cfg.mapRadius * 0.7))));
      if (!t) break;
      t.structure = { kind: "tower" };
      placed.tower!.push(t);
    }
    // Boards with a couple of old posts.
    for (let i = 0; i < cfg.boards; i++) {
      const t = pickTile(farFrom([cacheTile, ...placed.board!], 4));
      if (!t) break;
      const posts: BoardPost[] = (INITIAL_BOARD_POSTS[i] ?? []).map((p) => ({ tick: 0, by: "ruin", byName: p.by, text: p.text }));
      t.structure = { kind: "board", posts };
      placed.board!.push(t);
      if (i === 0) t.items.push("map");
    }
    // Vault: far from the centre, on rock or sand if possible; locked; stocked.
    const vaultTile = pickTile((x) => (x.terrain === "rock" || x.terrain === "sand") && hexDistance(x, cacheTile) >= Math.floor(cfg.mapRadius * 0.6));
    if (vaultTile) {
      vaultTile.structure = { kind: "vault", locked: true };
      vaultTile.food = 120;
      vaultTile.foodCap = 0;
      vaultTile.items.push("relay", "seeds");
      placed.vault!.push(vaultTile);
    }
    // Hidden items. The key is buried somewhere quiet; the map item knows where.
    const hiddenSpots: { item: ItemKind; tile: Tile }[] = [];
    const bury = (item: ItemKind, pred: (t: Tile) => boolean) => {
      const t = pickTile((x) => pred(x) && x.hidden.length === 0);
      if (!t) return;
      t.hidden.push(item);
      hiddenSpots.push({ item, tile: t });
    };
    bury("key", (t) => t.terrain === "sand" || t.terrain === "grass");
    bury("lantern", (t) => t.terrain === "rock" || t.terrain === "sand");
    bury("seeds", (t) => t.terrain === "forest");
    bury("seeds", (t) => t.terrain === "forest");
    bury("relay", (t) => t.terrain === "grass");

    // Ancient ruins: dead nodes with files, placed near the features they talk about.
    const near = (kind: keyof typeof placed, radius: number) => (t: Tile) => (placed[kind] ?? []).some((p) => hexDistance(t, p) <= radius && hexDistance(t, p) >= 1);
    for (const ruin of ANCIENT_RUINS) {
      const pred = ruin.near === "anywhere" ? () => true : near(ruin.near, 2);
      const t = pickTile(pred);
      if (!t) continue;
      const files = { ...ruin.files };
      if (files["map.txt"] !== undefined) files["map.txt"] = this.mapText(placed, hiddenSpots);
      const a = this.spawnAgent({ name: ruin.name, at: t, files, silent: true });
      a.profile = { ...ruin.profile };
      a.alive = false;
      a.diedTick = 0;
      a.food = 0;
      a.energy = 0;
      a.health = 0;
      a.inventory = { food: 0, wood: 0, stone: 0, items: [] };
    }
    this.pendingEvents = [];
    for (const t of this.tiles) if (t.structure || t.items.length) this.dirtyTiles.add(hexKey(t));
  }

  /** The Cartographer's map: real coordinates of every feature, with hidden things described vaguely. */
  private mapText(placed: Record<string, Hex[]>, hidden: { item: ItemKind; tile: Tile }[]): string {
    const lines: string[] = ["CARTOGRAPHER'S MAP (q,r axial coordinates; 0,0 is the centre)"];
    for (const [kind, pts] of Object.entries(placed)) for (const p of pts) lines.push(`${kind.padEnd(7)} at ${p.q},${p.r}`);
    for (const h of hidden) lines.push(`something buried at ${h.tile.q},${h.tile.r} (${h.tile.terrain}). stand on it to find out.`);
    lines.push("the vault is shut. a key opens it. i never found the key.");
    return lines.join("\n");
  }

  tileAt(h: Hex): Tile | undefined {
    return this.tileIndex.get(hexKey(h));
  }

  /** Passable for a given mover (vault doors open for key holders). */
  isPassable(h: Hex, mover?: Agent): boolean {
    const t = this.tileAt(h);
    if (!t || t.terrain === "water") return false;
    const s = t.structure;
    if (!s) return true;
    if (s.kind === "wall") return false;
    if (s.kind === "vault" && s.locked) return !!mover && mover.inventory.items.includes("key");
    return true;
  }

  private markDirty(t: Tile): void {
    this.dirtyTiles.add(hexKey(t));
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

  visionRadiusFor(a: Agent): number {
    if (this.isNight && a.inventory.items.includes("lantern")) return this.config.visionRadius;
    return this.currentVisionRadius;
  }

  /** send() range for a node: towers next to it reach the whole map; a carried relay doubles the base. */
  sendRadiusFor(a: Agent): number {
    const cfg = this.config;
    for (const h of hexesWithin(a, 1)) if (this.tileAt(h)?.structure?.kind === "tower") return cfg.towerSendRadius;
    return a.inventory.items.includes("relay") ? cfg.sendRadius * 2 : cfg.sendRadius;
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

  private cacheTile(): Tile | undefined {
    return this.tiles.find((t) => t.structure?.kind === "cache");
  }

  /** Random passable tile near the Cache (so nodes meet), preferring free ones. */
  private pickSpawnTile(): Tile {
    const occupied = new Set([...this.agents.values()].map((a) => hexKey(a)));
    const centre = this.cacheTile() ?? { q: 0, r: 0 };
    const free = (t: Tile) => t.terrain !== "water" && !occupied.has(hexKey(t)) && (!t.structure || t.structure.kind === "spring");
    let pool = this.tiles.filter((t) => free(t) && hexDistance(t, centre) <= this.config.spawnRadius);
    if (!pool.length) pool = this.tiles.filter(free);
    if (!pool.length) pool = this.tiles.filter((t) => t.terrain !== "water");
    if (!pool.length) throw new WorldError("no land to spawn on");
    return this.rng.pick(pool);
  }

  spawnAgent(opts: { name?: string; at?: Hex; files?: Record<string, string>; silent?: boolean } = {}): Agent {
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
      inventory: { food: 10, wood: 0, stone: 0, items: [] },
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
    if (!opts.silent) this.emit("spawned", 2, agent, `${name} appeared at ${tile.q},${tile.r}`);
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
    this.dirtyTiles.clear();
    if (seed !== undefined) this.config.seed = seed;
    this.rng.setState(this.config.seed);
    this.generate();
    this.emit("world-reset", 3, undefined, `The world was reset (seed ${this.config.seed})`);
  }

  // ----------------------------------------------------------------- events

  private emit(kind: EventKind, importance: 0 | 1 | 2 | 3, agent: Agent | undefined, text: string, extra: Partial<WorldEvent> = {}): WorldEvent {
    const ev: WorldEvent = { id: this.nextEventId++, tick: this.tick, day: this.day, kind, importance, text, ...extra };
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

  drainDirtyTiles(): TileView[] {
    if (this.dirtyTiles.size === 0) return [];
    const out: TileView[] = [];
    for (const k of this.dirtyTiles) {
      const t = this.tileIndex.get(k);
      if (t) out.push(this.tileView(t));
    }
    this.dirtyTiles.clear();
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

  private structureSummary(s: Structure | undefined): Record<string, unknown> | undefined {
    if (!s) return undefined;
    const out: Record<string, unknown> = { kind: s.kind };
    if (s.text !== undefined) out.text = s.text;
    if (s.posts) out.posts = s.posts.length;
    if (s.entries) out.entries = Object.keys(s.entries).length;
    if (s.locked !== undefined) out.locked = s.locked;
    if (s.builtBy) out.builtBy = s.builtBy;
    return out;
  }

  observe(agentId: string): Record<string, unknown> {
    const me = this.getAgent(agentId);
    const radius = this.visionRadiusFor(me);
    const here = { q: me.q, r: me.r };
    const tiles = hexesWithin(here, radius)
      .map((h) => this.tileAt(h))
      .filter((t): t is Tile => !!t)
      .map((t) => {
        const o: Record<string, unknown> = { q: t.q, r: t.r, terrain: t.terrain, food: Math.round(t.food), dist: hexDistance(t, here) };
        if (t.wood > 0) o.wood = Math.round(t.wood);
        if (t.stone > 0) o.stone = Math.round(t.stone);
        const s = this.structureSummary(t.structure);
        if (s) o.structure = s;
        if (t.items.length) o.items = [...t.items];
        return o;
      });
    const nodes = [...this.agents.values()]
      .filter((a) => a.id !== me.id && a.alive && hexDistance(a, here) <= radius)
      .map((a) => ({ id: a.id, name: a.name, q: a.q, r: a.r, dist: hexDistance(a, here), profile: { ...a.profile }, lastSaid: a.lastSaid?.text }));
    const ruins = [...this.agents.values()]
      .filter((a) => !a.alive && hexDistance(a, here) <= radius)
      .map((a) => ({ id: a.id, name: a.name, q: a.q, r: a.r, dist: hexDistance(a, here), diedTick: a.diedTick, fileCount: Object.keys(a.files).length, profile: { ...a.profile } }));
    const hereTile = this.tileAt(here)!;
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
        inventory: { ...me.inventory, items: [...me.inventory.items] },
        profile: { ...me.profile },
        tileFood: Math.round(hereTile.food),
        terrain: hereTile.terrain,
        structure: this.structureSummary(hereTile.structure),
        itemsHere: [...hereTile.items],
        sendRadius: this.sendRadiusFor(me),
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
    const here = { q: a.q, r: a.r };
    let best: number | null = null;
    let bestDist = hexDistance(here, target);
    for (let i = 0; i < 6; i++) {
      const n = hexNeighbor(here, i);
      if (!this.isPassable(n, a) || !inMap(n, this.config.mapRadius)) continue;
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

  intentGather(agentId: string, what: unknown = "food"): void {
    const a = this.requireAlive(agentId);
    if (what !== "food" && what !== "wood" && what !== "stone") throw new WorldError('gather(what): what must be "food", "wood" or "stone"');
    a.intent.body = { kind: "gather", what };
  }

  intentDrop(agentId: string, amount: unknown): void {
    const a = this.requireAlive(agentId);
    a.intent.body = { kind: "drop", amount: clampAmount(amount, "drop") };
  }

  intentRest(agentId: string): void {
    const a = this.requireAlive(agentId);
    a.intent.body = { kind: "rest" };
  }

  intentEat(agentId: string, amount: unknown = 10): void {
    const a = this.requireAlive(agentId);
    a.intent.eat = clampAmount(amount, "eat");
  }

  intentBuild(agentId: string, what: unknown, text?: unknown): void {
    const a = this.requireAlive(agentId);
    if (typeof what !== "string" || !(what in BUILD_COSTS)) throw new WorldError(`build(what): what must be one of ${Object.keys(BUILD_COSTS).join(", ")}`);
    const cost = BUILD_COSTS[what as StructureKind]!;
    if ((cost.wood ?? 0) > a.inventory.wood || (cost.stone ?? 0) > a.inventory.stone) {
      throw new WorldError(`build(${what}) needs ${cost.wood ?? 0} wood and ${cost.stone ?? 0} stone; you have ${a.inventory.wood} wood and ${a.inventory.stone} stone`);
    }
    const tile = this.tileAt(a)!;
    if (tile.structure && !(what === "sign" && tile.structure.kind === "sign")) throw new WorldError(`there is already a ${tile.structure.kind} here`);
    if (text !== undefined && typeof text !== "string") throw new WorldError("build text must be a string");
    a.intent.body = { kind: "build", what: what as StructureKind, text: typeof text === "string" ? text.slice(0, this.config.signChars) : undefined };
  }

  intentDemolish(agentId: string): void {
    const a = this.requireAlive(agentId);
    const s = this.tileAt(a)!.structure;
    if (!s) throw new WorldError("nothing to demolish here");
    if (!DEMOLISHABLE.has(s.kind)) throw new WorldError(`a ${s.kind} cannot be demolished`);
    a.intent.body = { kind: "demolish" };
  }

  intentPlant(agentId: string): void {
    const a = this.requireAlive(agentId);
    if (!a.inventory.items.includes("seeds")) throw new WorldError("plant() needs seeds");
    const t = this.tileAt(a)!;
    if (t.terrain === "water" || t.terrain === "rock") throw new WorldError("nothing grows here");
    a.intent.body = { kind: "plant" };
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
    const range = this.sendRadiusFor(a);
    if (hexDistance(a, target) > range) throw new WorldError(`send: ${target.name} is out of range (${range})`);
    if (a.intent.sends.length >= this.config.maxSendsPerTick) throw new WorldError(`send: at most ${this.config.maxSendsPerTick} messages per tick`);
    a.intent.sends.push({ to, payload });
  }

  // ------------------------------------------------------- items (immediate)

  /** Pick up an item lying on the current tile. Immediate, not an intent. */
  take(agentId: string, what?: unknown): ItemKind {
    const a = this.requireAlive(agentId);
    const t = this.tileAt(a)!;
    if (t.items.length === 0) throw new WorldError("nothing to take here");
    if (a.inventory.items.length >= this.config.maxItems) throw new WorldError(`you can carry at most ${this.config.maxItems} items`);
    let idx = 0;
    if (what !== undefined) {
      idx = t.items.indexOf(what as ItemKind);
      if (idx < 0) throw new WorldError(`no ${String(what)} here`);
    }
    const item = t.items.splice(idx, 1)[0]!;
    a.inventory.items.push(item);
    this.markDirty(t);
    this.emit("took-item", 1, a, `${a.name} picked up a ${item} at ${t.q},${t.r}`, { data: { item } });
    if (item === "map") {
      const cart = [...this.agents.values()].find((x) => x.files["map.txt"] !== undefined && !x.alive);
      const text = cart?.files["map.txt"] ?? "the map is blank.";
      try {
        this.fsWrite(agentId, "map.txt", text, { silent: true });
      } catch {
        this.addLog(agentId, "map: no room in your files to copy it");
      }
    }
    return item;
  }

  dropItem(agentId: string, what: unknown): ItemKind {
    const a = this.requireAlive(agentId);
    const idx = a.inventory.items.indexOf(what as ItemKind);
    if (idx < 0) throw new WorldError(`you are not carrying a ${String(what)}`);
    const item = a.inventory.items.splice(idx, 1)[0]!;
    const t = this.tileAt(a)!;
    t.items.push(item);
    this.markDirty(t);
    this.emit("dropped-item", 1, a, `${a.name} dropped a ${item} at ${t.q},${t.r}`, { data: { item } });
    return item;
  }

  // -------------------------------------------------- signs, boards, cache

  private structureNear(a: Agent, kind: StructureKind, radius: number): { tile: Tile; structure: Structure } | undefined {
    const here = this.tileAt(a)!;
    if (here.structure?.kind === kind) return { tile: here, structure: here.structure };
    if (radius > 0) for (let d = 0; d < 6; d++) {
      const t = this.tileAt(hexNeighbor(a, d));
      if (t?.structure?.kind === kind) return { tile: t, structure: t.structure };
    }
    return undefined;
  }

  /** Rewrite the sign on the current tile (anyone can; it is just a sign). */
  signWrite(agentId: string, text: unknown): void {
    const a = this.requireAlive(agentId);
    if (typeof text !== "string") throw new WorldError("sign text must be a string");
    const t = this.tileAt(a)!;
    if (t.structure?.kind !== "sign") throw new WorldError('no sign here; build("sign", text) to make one');
    t.structure.text = text.slice(0, this.config.signChars);
    this.markDirty(t);
    this.emit("posted", 1, a, `${a.name} rewrote the sign at ${t.q},${t.r}`, { quote: t.structure.text });
  }

  boardRead(agentId: string): BoardPost[] {
    const a = this.requireAlive(agentId);
    const b = this.structureNear(a, "board", 1);
    if (!b) throw new WorldError("no board here or next to you");
    return (b.structure.posts ?? []).map((p) => ({ ...p }));
  }

  boardPost(agentId: string, text: unknown): void {
    const a = this.requireAlive(agentId);
    if (typeof text !== "string" || text.length === 0) throw new WorldError("post text must be a non-empty string");
    const b = this.structureNear(a, "board", 1);
    if (!b) throw new WorldError("no board here or next to you");
    const posts = (b.structure.posts ??= []);
    posts.push({ tick: this.tick, by: a.id, byName: a.name, text: text.slice(0, this.config.boardPostChars) });
    if (posts.length > this.config.boardMaxPosts) posts.splice(0, posts.length - this.config.boardMaxPosts);
    this.markDirty(b.tile);
    this.emit("posted", 1, a, `${a.name} posted on the board at ${b.tile.q},${b.tile.r}`, { quote: posts[posts.length - 1]!.text });
  }

  private requireCache(a: Agent): { tile: Tile; structure: Structure } {
    const c = this.structureNear(a, "cache", 1);
    if (!c) throw new WorldError("no cache here or next to you");
    c.structure.entries ??= {};
    return c;
  }

  private validateCacheName(name: unknown): string {
    if (typeof name !== "string" || name.length === 0 || name.length > this.config.cacheNameChars) throw new WorldError(`cache name must be 1..${this.config.cacheNameChars} chars`);
    if (!/^[A-Za-z0-9_.\-]+$/.test(name) || name === "." || name === "..") throw new WorldError("cache name may only contain letters, digits, _ . -");
    return name;
  }

  cacheList(agentId: string): CacheEntry[] {
    const a = this.requireAlive(agentId);
    const c = this.requireCache(a);
    return Object.values(c.structure.entries!).map(({ text: _t, ...e }) => e);
  }

  cacheRead(agentId: string, name: unknown): string | null {
    const a = this.requireAlive(agentId);
    const c = this.requireCache(a);
    const e = c.structure.entries![this.validateCacheName(name)];
    return e ? e.text : null;
  }

  /** mkdir / write: creates or overwrites an entry. Names are the message; content is optional. */
  cacheWrite(agentId: string, name: unknown, text: unknown = ""): void {
    const a = this.requireAlive(agentId);
    const c = this.requireCache(a);
    const n = this.validateCacheName(name);
    if (typeof text !== "string") throw new WorldError("cache content must be a string");
    if (utf8Bytes(text) > this.config.cacheEntryBytes) throw new WorldError(`cache entry content is limited to ${this.config.cacheEntryBytes} bytes`);
    const entries = c.structure.entries!;
    if (!(n in entries) && Object.keys(entries).length >= this.config.cacheMaxEntries) throw new WorldError(`the cache is full (${this.config.cacheMaxEntries} entries); rmdir something`);
    entries[n] = { name: n, by: a.id, byName: a.name, tick: this.tick, bytes: utf8Bytes(text), text };
    this.markDirty(c.tile);
    this.emit("cached", 1, a, `${a.name} made "${n}" in the cache`, { quote: n });
  }

  cacheRemove(agentId: string, name: unknown): boolean {
    const a = this.requireAlive(agentId);
    const c = this.requireCache(a);
    const n = this.validateCacheName(name);
    if (!(n in c.structure.entries!)) return false;
    delete c.structure.entries![n];
    this.markDirty(c.tile);
    this.emit("cached", 0, a, `${a.name} removed "${n}" from the cache`);
    return true;
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

  fsAppend(agentId: string, path: unknown, content: unknown): void {
    if (typeof content !== "string") throw new WorldError("content must be a string");
    const existing = this.fsRead(agentId, path) ?? "";
    this.fsWrite(agentId, path, existing + content);
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
      const destTile = this.tileAt(dest);
      if (a.energy < cfg.moveEnergy) {
        this.addLog(a.id, "move: too tired");
      } else if (!destTile || !inMap(dest, cfg.mapRadius) || !this.isPassable(dest, a)) {
        this.addLog(a.id, `move: blocked (${DIRECTION_NAMES[it.move]})`);
      } else {
        a.q = dest.q;
        a.r = dest.r;
        a.energy -= cfg.moveEnergy;
        this.emit("moved", 0, a, `${a.name} moved ${DIRECTION_NAMES[it.move]} to ${dest.q},${dest.r}`);
        if (destTile.structure?.kind === "vault" && destTile.structure.locked) {
          destTile.structure.locked = false;
          this.markDirty(destTile);
          this.emit("vault-opened", 3, a, `${a.name} opened the vault at ${dest.q},${dest.r}`);
        }
        this.reveal(a, destTile);
      }
    } else if (it.body) {
      const tile = this.tileAt(a)!;
      switch (it.body.kind) {
        case "gather": {
          if (a.energy < cfg.gatherEnergy) {
            this.addLog(a.id, "gather: too tired");
            break;
          }
          const what = it.body.what;
          const inv = a.inventory;
          const cap = what === "food" ? cfg.maxInventoryFood : what === "wood" ? cfg.maxInventoryWood : cfg.maxInventoryStone;
          const amount = what === "food" ? cfg.gatherAmount : what === "wood" ? cfg.gatherWoodAmount : cfg.gatherStoneAmount;
          const room = cap - inv[what];
          const n = Math.min(amount, tile[what], room);
          a.energy -= cfg.gatherEnergy;
          if (n > 0) {
            tile[what] -= n;
            inv[what] += n;
            if (what !== "food") this.markDirty(tile);
            this.emit("gathered", 0, a, `${a.name} gathered ${Math.round(n)} ${what}`, { data: { what, n } });
          } else {
            this.addLog(a.id, room <= 0 ? `gather: no room for more ${what}` : `gather: no ${what} here`);
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
        case "build": {
          const cost = BUILD_COSTS[it.body.what]!;
          if (a.energy < cfg.buildEnergy) {
            this.addLog(a.id, "build: too tired");
            break;
          }
          if ((cost.wood ?? 0) > a.inventory.wood || (cost.stone ?? 0) > a.inventory.stone) {
            this.addLog(a.id, "build: not enough materials");
            break;
          }
          if (tile.structure && !(it.body.what === "sign" && tile.structure.kind === "sign")) {
            this.addLog(a.id, `build: there is already a ${tile.structure.kind} here`);
            break;
          }
          a.inventory.wood -= cost.wood ?? 0;
          a.inventory.stone -= cost.stone ?? 0;
          a.energy -= cfg.buildEnergy;
          const s: Structure = { kind: it.body.what, builtBy: a.id };
          if (it.body.what === "sign") s.text = it.body.text ?? "";
          if (it.body.what === "board") s.posts = [];
          tile.structure = s;
          this.markDirty(tile);
          this.emit("built", 2, a, `${a.name} built a ${it.body.what} at ${a.q},${a.r}`, { quote: s.text, data: { what: it.body.what } });
          break;
        }
        case "demolish": {
          const s = tile.structure;
          if (!s || !DEMOLISHABLE.has(s.kind)) {
            this.addLog(a.id, "demolish: nothing demolishable here");
            break;
          }
          if (a.energy < cfg.demolishEnergy) {
            this.addLog(a.id, "demolish: too tired");
            break;
          }
          a.energy -= cfg.demolishEnergy;
          delete tile.structure;
          this.markDirty(tile);
          this.emit("demolished", 2, a, `${a.name} demolished the ${s.kind} at ${a.q},${a.r}`, { data: { what: s.kind, builtBy: s.builtBy } });
          break;
        }
        case "plant": {
          const idx = a.inventory.items.indexOf("seeds");
          if (idx < 0 || tile.terrain === "water" || tile.terrain === "rock") {
            this.addLog(a.id, "plant: nothing happened");
            break;
          }
          a.inventory.items.splice(idx, 1);
          tile.foodCap = Math.min(60, tile.foodCap + 20);
          this.markDirty(tile);
          this.emit("planted", 2, a, `${a.name} planted seeds at ${a.q},${a.r}; the ground is richer now`);
          break;
        }
      }
    }
  }

  /** Standing on a tile reveals whatever was buried there. */
  private reveal(a: Agent, t: Tile): void {
    if (t.hidden.length === 0) return;
    const found = t.hidden.splice(0);
    t.items.push(...found);
    this.markDirty(t);
    this.emit("found", 2, a, `${a.name} found ${found.join(" and ")} buried at ${t.q},${t.r}`, { data: { items: found } });
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
      // Everything it carried falls to the ground.
      const t = this.tileAt(a)!;
      t.food += a.inventory.food;
      t.wood += a.inventory.wood;
      t.stone += a.inventory.stone;
      t.items.push(...a.inventory.items);
      a.inventory = { food: 0, wood: 0, stone: 0, items: [] };
      this.markDirty(t);
      this.emit("died", 3, a, `${a.name} died at ${a.q},${a.r}. Its files remain.`);
    }
  }

  private regrow(): void {
    const cfg = this.config;
    for (const t of this.tiles) {
      const rate = t.structure?.kind === "spring" ? cfg.springRegrowthPerTick : cfg.regrowthPerTick;
      if (t.foodCap > 0 && t.food < t.foodCap) t.food = Math.min(t.foodCap, t.food + t.foodCap * rate);
      if (t.woodCap > 0 && t.wood < t.woodCap) t.wood = Math.min(t.woodCap, t.wood + t.woodCap * cfg.materialRegrowthPerTick);
      if (t.stoneCap > 0 && t.stone < t.stoneCap) t.stone = Math.min(t.stoneCap, t.stone + t.stoneCap * cfg.materialRegrowthPerTick);
    }
  }

  // ------------------------------------------------------------------ views

  structureView(s: Structure | undefined): StructureView | undefined {
    if (!s) return undefined;
    const v: StructureView = { kind: s.kind };
    if (s.text !== undefined) v.text = s.text;
    if (s.posts) v.posts = s.posts.map((p) => ({ ...p }));
    if (s.entries) v.entries = Object.values(s.entries).map(({ text: _t, ...e }) => e);
    if (s.builtBy) v.builtBy = s.builtBy;
    if (s.locked !== undefined) v.locked = s.locked;
    return v;
  }

  tileView(t: Tile): TileView {
    const v: TileView = { q: t.q, r: t.r, terrain: t.terrain, food: Math.round(t.food), foodCap: t.foodCap, wood: Math.round(t.wood), stone: Math.round(t.stone) };
    const s = this.structureView(t.structure);
    if (s) v.structure = s;
    if (t.items.length) v.items = [...t.items];
    return v;
  }

  tileViews(): TileView[] {
    return this.tiles.map((t) => this.tileView(t));
  }

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
      inventory: { food: round1(a.inventory.food), wood: round1(a.inventory.wood), stone: round1(a.inventory.stone), items: [...a.inventory.items] },
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
      version: 2,
      config: { ...this.config },
      tick: this.tick,
      rngState: this.rng.getState(),
      nextAgentIndex: this.nextAgentIndex,
      nextEventId: this.nextEventId,
      tiles: this.tiles.map((t) => structuredClone(t)),
      agents: [...this.agents.values()].map(({ intent: _i, wasStarving: _s, wasExhausted: _e, ...rest }) => structuredClone(rest)),
    };
  }

  static restore(snap: WorldSnapshot): World {
    if (snap.version !== 2) throw new WorldError(`unsupported snapshot version ${String(snap.version)}`);
    const w = new World(snap.config, { generate: false });
    w.tick = snap.tick;
    w.rng.setState(snap.rngState);
    w.nextAgentIndex = snap.nextAgentIndex;
    w.nextEventId = snap.nextEventId;
    for (const t of snap.tiles) {
      const tile = structuredClone(t);
      tile.items ??= [];
      tile.hidden ??= [];
      w.tiles.push(tile);
      w.tileIndex.set(hexKey(tile), tile);
    }
    for (const a of snap.agents) {
      const agent = structuredClone(a) as Agent;
      agent.inventory = Object.assign({ food: 0, wood: 0, stone: 0, items: [] }, agent.inventory);
      agent.intent = { sends: [] };
      agent.wasStarving = agent.alive && agent.food <= 0;
      agent.wasExhausted = agent.alive && agent.energy <= 0;
      w.agents.set(agent.id, agent);
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
