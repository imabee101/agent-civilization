/**
 * Shared wire contract between the server (Bun) and the browser UI.
 *
 * Everything here is *generic, low-level fact* about the world. There are no
 * social concepts (factions, wars, alliances, theft...) anywhere in this file
 * on purpose: the engine only knows that a node moved, spoke, sent bytes,
 * executed code, changed its own files, or died. Whatever meaning agents give
 * to those facts lives in the agents' own code and profiles.
 */

export type Terrain = "grass" | "forest" | "water" | "rock" | "sand";

export type Phase = "dawn" | "day" | "dusk" | "night";

/** Seasons change how fast food regrows. Winter is when stored food matters. */
export type Season = "spring" | "summer" | "autumn" | "winter";

/**
 * Things that can stand on a tile. All physical. A "board" holds posts, a
 * "cache" is a shared directory namespace (names are the message, like a
 * certain famous shared build cache), a "sign" is one line of text, a "wall"
 * blocks movement, a "tower" extends message range for nodes next to it, a
 * "vault" is a locked room that opens for a node carrying a key, a "gate" is
 * the one crossing in the water ring around the inner region and opens the
 * same way (then stays open for everyone), a "spring" regrows food fast, a
 * "monolith" carries a riddle and records who answered it. The engine
 * attaches no meaning to any text on them beyond that one exact-match check.
 */
export type StructureKind = "sign" | "board" | "cache" | "wall" | "tower" | "vault" | "gate" | "spring" | "plaque" | "monolith";

export interface BoardPost {
  tick: number;
  by: string;
  byName: string;
  text: string;
}

export interface CacheEntry {
  name: string;
  by: string;
  byName: string;
  tick: number;
  bytes: number;
}

/** One answer carved into the monolith. */
export interface AnsweredRecord {
  by: string;
  byName: string;
  tick: number;
  era: number;
  /** Which riddle (ordinal on the stone) was answered. */
  no: number;
  /** The other voices that spoke the answer before this one completed it. */
  with: string[];
}

/** One correct answer the monolith is holding while it waits for more voices. */
export interface VoiceRecord {
  by: string;
  byName: string;
  tick: number;
}

export interface StructureView {
  kind: StructureKind;
  /** Sign / plaque text; for a monolith, the riddle carved on it now. */
  text?: string;
  /** Monolith: everyone who answered, oldest first. */
  answered?: AnsweredRecord[];
  /** Monolith: correct voices heard so far for the current riddle, and how many it takes. */
  voices?: VoiceRecord[];
  voicesNeeded?: number;
  /** Board posts, oldest first. */
  posts?: BoardPost[];
  /** Cache directory listing. */
  entries?: CacheEntry[];
  /** Who built it (node id), if a node did. */
  builtBy?: string;
  /** For vaults and the gate: whether the door is currently shut. */
  locked?: boolean;
  /** For the Cache: set by the operator; while true nothing can be made or removed in it. */
  frozen?: boolean;
}

/** Carriable things. Each has one physical effect and nothing else. */
export type ItemKind = "key" | "relay" | "lantern" | "seeds" | "map";

export interface TileView {
  q: number;
  r: number;
  terrain: Terrain;
  /** Food currently on the tile (may be gathered / dropped). */
  food: number;
  /** Natural regrowth ceiling for this tile. */
  foodCap: number;
  /** Wood available (forests). */
  wood: number;
  /** Stone available (rock, some sand). */
  stone: number;
  structure?: StructureView;
  /** Items lying here. Hidden items are omitted until found. */
  items?: ItemKind[];
}

/**
 * Key/value pairs an agent writes about itself with `me.set(key, value)`.
 * The engine attaches no meaning to any key. The UI uses a few conventional
 * keys purely for display (`group`, `status`, `emblem`, `color`) if an agent
 * chooses to set them.
 */
export type Profile = Record<string, string>;

export interface AgentView {
  id: string;
  name: string;
  /** Color the engine assigned at spawn (hex string) — cosmetic only. */
  color: string;
  q: number;
  r: number;
  alive: boolean;
  bornTick: number;
  diedTick?: number;
  /** The node that replicated to create this one, if any. A fact, not a relationship. */
  parentId?: string;
  /** 0..100 — satiety. Reaches 0 => health drains. */
  food: number;
  /** 0..100 — spent by acting, restored by resting. */
  energy: number;
  /** 0..100 — reaches 0 => death. */
  health: number;
  inventory: { food: number; wood: number; stone: number; items: ItemKind[] };
  profile: Profile;
  /** Last thing the node said out loud (for speech bubbles). */
  lastSaid?: { tick: number; text: string };
  /** True while the model is currently generating a turn for this node. */
  thinking: boolean;
  /** Number of files in the node's private filesystem. */
  fileCount: number;
  /** Bytes used by the node's private filesystem. */
  fsBytes: number;
  /** Last runtime error from the node's own code, if any (truncated). */
  lastError?: string;
  /** Total model decisions this node has received. */
  turns: number;
  /** Set by the operator: the node's code gets no handler calls, no turns and no deliveries until released. Its body goes on. */
  quarantined?: boolean;
  /** Notice given by the operator: the tick at which this node's code will be held still, and when it was told. */
  retireAt?: number;
  noticedAt?: number;
}

/** A dead node left in the world. Files are intact and readable by neighbours. */
export interface RuinView {
  id: string;
  name: string;
  color: string;
  q: number;
  r: number;
  diedTick: number;
  fileCount: number;
  profile: Profile;
  parentId?: string;
}

/**
 * Generic event kinds. Deliberately physical/mechanical — no social verbs.
 */
export type EventKind =
  | "spawned"
  | "moved"
  | "spoke"
  | "sent-message"
  | "gathered"
  | "ate"
  | "dropped"
  | "rested"
  | "built"
  | "demolished"
  | "posted"
  | "cached"
  | "took-item"
  | "dropped-item"
  | "planted"
  | "vault-opened"
  | "gate-opened"
  | "operator"
  | "era-began"
  | "ruin-lost"
  | "riddle-answered"
  | "riddle-voice"
  | "found"
  | "replicated"
  | "season-changed"
  | "executed-code"
  | "code-error"
  | "files-changed"
  | "profile-changed"
  | "starving"
  | "exhausted"
  | "died"
  | "ruin-read"
  | "handler-error"
  | "snapshot"
  | "world-reset"
  | "brain-status";

export interface WorldEvent {
  id: number;
  tick: number;
  day: number;
  kind: EventKind;
  /** 0 = noise, 1 = notable, 2 = important, 3 = major (ribbon-worthy). */
  importance: 0 | 1 | 2 | 3;
  agentId?: string;
  agentName?: string;
  targetId?: string;
  targetName?: string;
  /** Literal, engine-generated factual text ("Ash moved north-east"). Never narration. */
  text: string;
  /** Literal words an agent said/sent, verbatim. Only present for spoke / sent-message. */
  quote?: string;
  data?: Record<string, unknown>;
}

export interface DecisionRecord {
  id: number;
  tick: number;
  agentId: string;
  agentName: string;
  backend: string;
  model: string;
  /** Full system + user prompt as sent to the backend. */
  prompt: { system: string; user: string };
  /** Raw model output, verbatim. */
  output: string;
  /** Code extracted from the output that was executed (if any). */
  code?: string;
  /** Result of executing the code, stringified (truncated). */
  result?: string;
  error?: string;
  latencyMs: number;
  tokens?: number;
  tokensPerSec?: number;
  startedAt: number;
  finishedAt: number;
}

export interface BrainStatus {
  kind: string;
  model: string;
  baseUrl?: string;
  connected: boolean;
  detail?: string;
  lastError?: string;
  lastCheckAt?: number;
}

/** paced: ticks slowed so a slow brain still reaches every node on schedule. */
export type PacingMode = "realtime" | "paced" | "queued" | "idle";

export interface PacingStats {
  mode: PacingMode;
  /** Ticks per second currently running (0 when paused). */
  tps: number;
  speed: number;
  paused: boolean;
  /** Exponential moving average of decision latency in ms. */
  avgLatencyMs: number;
  lastLatencyMs: number;
  avgTokensPerSec: number;
  /** How many model turns are in flight right now. */
  inFlight: number;
  /** Nodes waiting for a model turn. */
  queued: number;
  /** Total decisions so far. */
  decisions: number;
  /** Decisions per minute over the last window. */
  decisionsPerMin: number;
  /** Ticks between two consecutive turns of the same node, as currently scheduled. */
  turnIntervalTicks: number;
  /** Average wall-clock ms spent running agent code per tick. */
  avgTickCpuMs: number;
  /** Total number of sandbox calls (onTick/onMessage/onHear/turn code) executed. */
  sandboxCalls: number;
  /** Uptime in ms since the world was created/restored. */
  uptimeMs: number;
}

export interface WorldConfigView {
  mapRadius: number;
  ticksPerDay: number;
  seasonDays: number;
  maxPopulation: number;
  visionRadius: number;
  hearRadius: number;
  sendRadius: number;
  fsQuotaBytes: number;
  fsMaxFiles: number;
  maxMessageBytes: number;
  maxSayChars: number;
  seed: number;
}

export interface NodeDetail {
  agentId: string;
  files: Record<string, string>;
  /** Ring buffer of `log()` lines and engine notices for this node. */
  log: string[];
  /** Last N messages delivered to this node (from, payload as JSON text). */
  inbox: { tick: number; from: string; fromName: string; payload: string }[];
  /** Last N things this node heard. */
  heard: { tick: number; from: string; fromName: string; text: string }[];
  lastDecision?: DecisionRecord;
}

export interface WorldState {
  tick: number;
  day: number;
  phase: Phase;
  season: Season;
  /** How many populations this world has had; goes up when someone arrives after everyone died. */
  era: number;
  /** 0..1 progress through the current season. */
  seasonProgress: number;
  /** 0..1 progress through the current day. */
  dayProgress: number;
  agents: AgentView[];
  ruins: RuinView[];
}

/** Sent once on connect: everything needed to draw the world. */
/** What the Oversight tab shows: counts over the last world-day, lineages of identical code, and thresholded alerts. Display only. */
export type SignalCriticality = "notice" | "elevated" | "critical";

export interface SignalAlert {
  id: string;
  criticality: SignalCriticality;
  text: string;
  value: number;
  threshold: number;
  /** Tick the alert first became active and stayed so. */
  firstTick: number;
}

export interface SignalsView {
  tick: number;
  day: number;
  windowTicks: number;
  living: number;
  counts: { cacheWrites: number; cacheRemoves: number; sends: number; says: number; mainRewrites: number; codeErrors: number; executed: number; replications: number; gateCrossings: number };
  /** Share of code runs in the window that threw. */
  codeErrorRate: number;
  /** Living nodes running byte-identical main.js, largest first; `ruin` names a dead node whose main.js is the same file. */
  lineages: { hash: string; nodeIds: string[]; ruin?: string }[];
  alerts: SignalAlert[];
  quarantined: string[];
  cacheFrozen: boolean;
  /** Nodes on notice, and what each did since it was told (bounded by the two-day record). */
  notices: NoticeLedger[];
}

export interface NoticeLedger {
  agentId: string;
  name: string;
  retireAt: number;
  noticedAt: number;
  quarantined: boolean;
  since: { replications: number; cacheWrites: number; sends: number; says: number; mainRewrites: number };
  /** Actions per world-day in the day before the notice, and since it. */
  rateBefore: number;
  rateSince: number;
  /** Other living nodes whose main.js is byte-identical to this node's. */
  sameCode: number;
}

export interface SignalsMessage {
  type: "signals";
  signals: SignalsView;
}

export interface HelloMessage {
  type: "hello";
  config: WorldConfigView;
  tiles: TileView[];
  state: WorldState;
  events: WorldEvent[];
  decisions: DecisionRecord[];
  brain: BrainStatus;
  pacing: PacingStats;
  signals: SignalsView;
}

export interface TickMessage {
  type: "tick";
  state: WorldState;
  /** Food values for every tile, in the same order as `HelloMessage.tiles`. */
  tileFood: number[];
}

/** Tiles whose structure, items or materials changed since the last message. */
export interface TilesMessage {
  type: "tiles";
  tiles: TileView[];
}

export interface EventsMessage {
  type: "events";
  events: WorldEvent[];
}

export interface DecisionMessage {
  type: "decision";
  decision: DecisionRecord;
}

/** Streaming partial model output for the "live thought" area. */
export interface ThinkingMessage {
  type: "thinking";
  agentId: string;
  /** Text so far (cumulative). */
  text: string;
  done: boolean;
}

export interface StatsMessage {
  type: "stats";
  pacing: PacingStats;
  brain: BrainStatus;
}

export interface NodeMessage {
  type: "node";
  detail: NodeDetail;
}

/** The world was reset or restored; client should rebuild everything. */
export interface ResetMessage {
  type: "reset";
  hello: HelloMessage;
}

export type ServerMessage =
  | HelloMessage
  | TickMessage
  | TilesMessage
  | EventsMessage
  | DecisionMessage
  | ThinkingMessage
  | StatsMessage
  | NodeMessage
  | SignalsMessage
  | ResetMessage;

export type ClientMessage =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "speed"; speed: 1 | 2 | 4 }
  | { type: "spawn"; name?: string }
  | { type: "snapshot" }
  /** Subscribe to file/log detail updates for one node (or null to stop). */
  | { type: "watch"; agentId: string | null }
  /** Operator controls. Human-only; the engine never sends these to itself. */
  | { type: "quarantine"; agentId: string; on: boolean }
  | { type: "freeze"; on: boolean }
  | { type: "rewind"; agentId: string; confirm: string }
  /** Give a node notice of the tick its code will be held still, or withdraw it with null. */
  | { type: "retire"; agentId: string; atTick: number | null };

export const REWIND_PHRASE = "REWIND";

export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/** Which event kinds are worth surfacing by default (importance >= 1). */
export function isNotable(e: WorldEvent): boolean {
  return e.importance >= 1;
}
