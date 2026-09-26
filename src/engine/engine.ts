/**
 * The engine runs the world clock, keeps one sandbox per living node, feeds
 * deliveries to node handlers, asks the brain for turns, and takes snapshots.
 *
 * It contains no rules about what nodes may do to each other. It moves
 * bytes and time forward. That's it.
 */
import { FENCE_STOP, SYSTEM_PROMPT, buildUserPrompt, extractCode, longestParsingPrefix, relaxTopLevelDeclarations } from "../brain/prompt";
import { classifyBackend, type BackendProfile, type Brain } from "../brain/types";
import { NodeSandbox, type SandboxLimits } from "../sandbox/sandbox";
import type { HandlerName } from "../sandbox/api";
import type { BrainStatus, DecisionRecord, HelloMessage, NodeDetail, PacingStats, ServerMessage, SignalsView, Speed, WorldEvent } from "../shared/protocol";
import { World, type Agent, type WorldConfig, type WorldSnapshot, type Delivery } from "../world/world";
import { makeBridge } from "./bridge";
import { Signals } from "./signals";
import type { HistoryStore } from "./history";
import { Pacing, dueIn, type PacingConfig, type Urgency } from "./pacing";

export interface EngineConfig extends PacingConfig {
  world: Partial<WorldConfig>;
  sandbox: Partial<SandboxLimits>;
  initialAgents: number;
  maxAgents: number;
  /** While fewer nodes than this are alive, a newcomer arrives every `arrivalEveryTicks`. 0 disables. */
  arrivalFloor: number;
  arrivalEveryTicks: number;
  maxTokens: number;
  temperature: number;
  /** Character budget for the changing part of a turn prompt; sections shrink until it fits. 0 = no limit. Set from the backend's context unless given. */
  promptMaxChars: number;
  /** Backend slots to pin nodes to, one node per slot while it lives (0 = let the backend choose). Set from the backend unless given. */
  slots: number;
  /** Ticks between automatic snapshots (0 disables). */
  snapshotEveryTicks: number;
  snapshotPath?: string;
  /** Ring buffer sizes for the UI. */
  keepDecisions: number;
  keepEvents: number;
  /** Push an Oversight `signals` message every this many ticks. 0 disables the push (the route still works). */
  signalsEveryTicks: number;
  /** Days of routine (importance-0) history rows kept; the rest of the history is kept forever. */
  historyNoiseDays: number;
  /** Ms between brain health probes. */
  healthEveryMs: number;
  /** Ms to wait before retrying the brain after a failed call. */
  brainRetryMs: number;
  /** Times a failed turn is tried again on the same facts, after `brainRetryMs`, before it is given up. */
  brainRetries: number;
  /** Starter files every new node gets. */
  starterFiles: Record<string, string>;
}

export const STARTER_MAIN_JS = `// This is your node's script. It is re-run whenever you change it.
// Define onTick(), onMessage(fromId, msg), onHear(fromId, text) here to keep
// behaving between your turns. Right now it does nothing.
`;

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  world: {},
  sandbox: {},
  tickMs: 500,
  turnIntervalTicks: 16,
  concurrency: 1,
  maxTickMs: 5000,
  initialAgents: 6,
  maxAgents: 64,
  arrivalFloor: 4,
  arrivalEveryTicks: 60,
  maxTokens: 400,
  temperature: 0.7,
  promptMaxChars: 12_000,
  slots: 0,
  snapshotEveryTicks: 120,
  snapshotPath: undefined,
  keepDecisions: 200,
  keepEvents: 600,
  signalsEveryTicks: 20,
  historyNoiseDays: 7,
  healthEveryMs: 30_000,
  brainRetryMs: 5_000,
  brainRetries: 1,
  starterFiles: { "main.js": STARTER_MAIN_JS },
};

export interface EngineSnapshot {
  version: 1;
  savedAt: number;
  world: WorldSnapshot;
  events: WorldEvent[];
  decisions: DecisionRecord[];
  nextDecisionId: number;
}

interface NodeRuntime {
  sandbox: NodeSandbox;
  /** The main.js source currently loaded into the sandbox. */
  loadedScript: string | undefined;
  lastResult?: string;
  /** Body at the start of the previous turn, for the "since your last turn" facts, plus what the node had seen by then (for urgency). */
  lastTurn?: { tick: number; stomach: number; energy: number; health: number; carried: number; inboxTick?: number; heardTick?: number; lastError?: string; structureKey?: string };
  /** Tick the node's last turn was dispatched; its next is due `dueIn(interval, urgency)` ticks later. */
  turnStartedTick?: number;
  nextTurnTick: number;
  inFlight: boolean;
  /** Backend slot this node's turns run in, for the life of the node. */
  slot?: number;
  /** Last error recorded per handler, so a loop that throws the same thing every tick is written down once. */
  lastHandlerError: Partial<Record<HandlerName, string>>;
}

type Listener = (msg: ServerMessage) => void;

/** Own events that make a node's next turn hot: its body crossed a line, it found something, the stone heard it, the operator touched it. */
const HOT_EVENTS = ["starving", "exhausted", "found", "riddle-voice", "riddle-answered", "vault-opened", "gate-opened", "operator", "died"] as const;
const URGENCY_RANK: Record<Urgency, number> = { hot: 2, warm: 1, cold: 0 };
/** Chars per token to size a prompt budget from a context length: measured on this prompt's mix of JSON and code. */
const CHARS_PER_TOKEN = 3.5;
/** Tokens left free in a slot's context beyond prompt and reply. */
const CONTEXT_MARGIN_TOKENS = 256;

/** A decision as pushed to clients: the system prompt is the same for every decision and travels once in hello. */
function onWire(d: DecisionRecord): DecisionRecord {
  return { ...d, prompt: { system: "", user: d.prompt.user } };
}

/** A node's own upkeep and the turn's own bookkeeping: not news, so a node whose handlers keep it fed can stay cold. */
const ROUTINE_EVENTS: ReadonlySet<string> = new Set(["executed-code", "code-error", "rested", "gathered", "ate", "moved", "dropped"]);

export class Engine {
  readonly cfg: EngineConfig;
  world: World;
  brain: Brain;
  readonly pacing: Pacing;
  /** Oversight bookkeeping over the event stream. Display only; nothing reads it back into the world. */
  signals: Signals;
  readonly nodes = new Map<string, NodeRuntime>();
  paused = true;
  speed: Speed = 1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;
  private events: WorldEvent[] = [];
  private decisions: DecisionRecord[] = [];
  private nextDecisionId = 1;
  private listeners = new Set<Listener>();
  private thinking = new Map<string, string>();
  private thinkingLastSent = new Map<string, number>();
  private brainStatus: BrainStatus;
  private brainBlockedUntil = 0;
  /** Config keys the caller set, so what the backend reports never overrides a choice a person made. */
  private readonly given: ReadonlySet<string>;
  private probing = false;
  private checking = false;
  /** When the brain was last seen failing, for the "back after" note. */
  private outageSince = 0;
  private lastRuinStamp = "";
  /** Events by kind since the engine started, for the metrics endpoint. */
  readonly eventCounts: Record<string, number> = {};
  private lastHealthAt = 0;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** Set from the world clock in the constructor so the first newcomer waits a full interval. */
  private lastArrivalTick: number;
  /** Bumped by reset(): a turn that started in an earlier epoch is discarded when it lands, since its node no longer exists. */
  private epoch = 0;
  private readonly turnAborts = new Set<AbortController>();
  /** Optional durable history (SQLite). */
  history: HistoryStore | undefined;

  constructor(brain: Brain, cfg: Partial<EngineConfig> = {}, world?: World) {
    this.cfg = { ...DEFAULT_ENGINE_CONFIG, ...cfg, world: { ...cfg.world }, sandbox: { ...cfg.sandbox } };
    this.given = new Set(Object.keys(cfg));
    this.brain = brain;
    this.world = world ?? new World(this.cfg.world);
    this.pacing = new Pacing({ tickMs: this.cfg.tickMs, turnIntervalTicks: this.cfg.turnIntervalTicks, concurrency: this.cfg.concurrency, maxTickMs: this.cfg.maxTickMs });
    this.signals = new Signals(this.world.config.ticksPerDay);
    this.brainStatus = { kind: brain.kind, model: brain.model, baseUrl: brain.baseUrl, connected: false };
    this.lastArrivalTick = this.world.tick;
  }

  // ------------------------------------------------------------ lifecycle

  /** Create sandboxes for living nodes and spawn the initial population if the world is empty. */
  async init(): Promise<void> {
    for (const a of this.world.livingAgents()) await this.attachSandbox(a.id);
    // A fresh world may already contain ancient ruins; only living nodes count as a population.
    if (this.world.livingAgents().length === 0 && this.world.tick === 0) {
      for (let i = 0; i < this.cfg.initialAgents; i++) await this.spawn();
    }
    this.flushEvents();
    await this.checkBrain();
    if (this.cfg.healthEveryMs > 0) {
      this.healthTimer = setInterval(() => void this.checkBrain(), this.cfg.healthEveryMs);
    }
  }

  /** Restore from a saved snapshot. Sandboxes are rebuilt from each node's files. */
  static async fromSnapshot(snap: EngineSnapshot, brain: Brain, cfg: Partial<EngineConfig> = {}): Promise<Engine> {
    if (snap.version !== 1) throw new Error(`unsupported engine snapshot version ${String(snap.version)}`);
    const world = World.restore(snap.world);
    const engine = new Engine(brain, cfg, world);
    engine.events = snap.events.slice(-engine.cfg.keepEvents);
    engine.decisions = snap.decisions.slice(-engine.cfg.keepDecisions);
    engine.nextDecisionId = snap.nextDecisionId;
    engine.signals.ingest(snap.events);
    await engine.init();
    engine.world.record("snapshot", 1, undefined, `World restored from snapshot saved ${new Date(snap.savedAt).toISOString()}`);
    engine.flushEvents();
    return engine;
  }

  start(): void {
    if (!this.paused) return;
    this.paused = false;
    this.schedule();
    this.emitStats();
  }

  pause(): void {
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.emitStats();
  }

  setSpeed(speed: Speed): void {
    this.speed = speed;
    this.emitStats();
  }

  /** Stop everything and free sandboxes. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.pause();
    this.abortTurns("shutdown");
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const [id, n] of this.nodes) {
      n.sandbox.dispose();
      this.nodes.delete(id);
    }
  }

  private schedule(): void {
    if (this.paused || this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, this.pacing.tickMsAt(this.speed, this.world.livingAgents().length));
  }

  // ------------------------------------------------------------- listeners

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(msg: ServerMessage): void {
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch {
        // a broken listener must not break the world
      }
    }
  }

  // ----------------------------------------------------------------- nodes

  /** Lowest backend slot no living node holds; undefined when none is configured or all are taken. */
  private freeSlot(): number | undefined {
    const taken = new Set([...this.nodes.values()].map((n) => n.slot));
    for (let i = 0; i < this.cfg.slots; i++) if (!taken.has(i)) return i;
    return undefined;
  }

  private async attachSandbox(agentId: string): Promise<NodeRuntime> {
    const existing = this.nodes.get(agentId);
    if (existing) existing.sandbox.dispose();
    const sandbox = await NodeSandbox.create(makeBridge(this.world, agentId), this.cfg.sandbox);
    const rt: NodeRuntime = { sandbox, loadedScript: undefined, nextTurnTick: this.world.tick, inFlight: existing?.inFlight ?? false, lastHandlerError: {} };
    rt.slot = existing?.slot ?? this.freeSlot();
    this.nodes.set(agentId, rt);
    this.loadScriptIfChanged(agentId, rt);
    this.replayTurnScript(agentId, rt);
    return rt;
  }

  /** A fresh sandbox holds only main.js; the node's last turn code (turn.js) ran on top of it, so it runs again. */
  private replayTurnScript(agentId: string, rt: NodeRuntime): void {
    const agent = this.world.agents.get(agentId);
    const src = agent?.alive && !agent.quarantined ? agent.files["turn.js"] : undefined;
    if (!agent || src === undefined || rt.sandbox.poisoned) return;
    const r = rt.sandbox.eval(relaxTopLevelDeclarations(src), "turn.js");
    this.pacing.sandboxCalls++;
    if (r.ok) {
      const handlers = rt.sandbox.handlers();
      this.world.addLog(agentId, `turn.js replayed (${handlers.length ? handlers.join(", ") : "no handlers"})`);
    } else {
      agent.lastError = `turn.js: ${r.error}`;
      this.world.addLog(agentId, `turn.js failed to replay: ${r.error}`);
      this.world.record("code-error", 1, agentId, `${agent.name}'s turn.js failed to replay`, { data: { error: r.error } });
    }
  }

  private loadScriptIfChanged(agentId: string, rt: NodeRuntime): void {
    const agent = this.world.agents.get(agentId);
    if (!agent || !agent.alive || agent.quarantined) return;
    const src = agent.files["main.js"];
    if (src === rt.loadedScript) return;
    rt.loadedScript = src;
    if (src === undefined) return;
    const r = rt.sandbox.loadScript(relaxTopLevelDeclarations(src));
    this.pacing.sandboxCalls++;
    if (!r.ok) {
      agent.lastError = `main.js: ${r.error}`;
      this.world.addLog(agentId, `main.js failed to load: ${r.error}`);
      this.world.record("code-error", 1, agentId, `${agent.name}'s main.js failed to load`, { data: { error: r.error } });
      if (r.fatal) void this.rebuildNode(agentId, r.error);
    } else {
      const handlers = rt.sandbox.handlers();
      this.world.addLog(agentId, `main.js loaded (${handlers.length ? handlers.join(", ") : "no handlers"})`);
    }
  }

  /** Replace a poisoned sandbox with a fresh one built from the node's files. */
  private async rebuildNode(agentId: string, reason: string): Promise<void> {
    const agent = this.world.agents.get(agentId);
    if (!agent || !agent.alive) return;
    this.world.addLog(agentId, `node runtime reset: ${reason}`);
    this.world.record("code-error", 1, agentId, `${agent.name}'s runtime was reset (${reason.slice(0, 80)})`, { data: { error: reason } });
    const rt = this.nodes.get(agentId);
    if (rt) rt.loadedScript = undefined;
    await this.attachSandbox(agentId);
  }

  async spawn(name?: string, opts: { arrival?: boolean } = {}): Promise<string> {
    if (this.world.livingAgents().length >= this.cfg.maxAgents) throw new Error(`at most ${this.cfg.maxAgents} living nodes`);
    const a = this.world.spawnAgent({ name, arrival: opts.arrival, files: this.cfg.starterFiles });
    await this.attachSandbox(a.id);
    this.flushEvents();
    this.emitTick();
    return a.id;
  }

  // ------------------------------------------------------- operator controls
  // Only a person calls these, through the server. Nothing in the engine
  // decides to. Each one is written down as an event so the record shows when
  // the operator acted next to when things happened.

  /** Hold a node's code still: no handler calls, no turns, no deliveries. Its body keeps draining. Release rebuilds its runtime from its files. */
  async quarantine(agentId: string, on: boolean): Promise<void> {
    const a = this.world.setQuarantined(agentId, on);
    if (on) {
      this.thinking.delete(agentId);
      this.world.addLog(agentId, "quarantined by the operator: your code is held still");
      this.world.record("operator", 2, agentId, `The operator quarantined ${a.name}`, { data: { action: "quarantine", on: true } });
    } else {
      this.world.addLog(agentId, "released by the operator: your runtime was rebuilt from your files");
      this.world.record("operator", 2, agentId, `The operator released ${a.name}`, { data: { action: "quarantine", on: false } });
      const rt = this.nodes.get(agentId);
      if (rt) rt.loadedScript = undefined;
      await this.attachSandbox(agentId);
    }
    this.flushEvents();
    this.emitTick();
  }

  /** Give a node notice of the tick its code will be held still, or withdraw it. What it does with the time is its own. */
  retire(agentId: string, atTick: number | null): void {
    const a = this.world.setRetireAt(agentId, atTick === null ? undefined : atTick);
    if (atTick === null) {
      this.world.addLog(agentId, "the operator withdrew your notice");
      this.world.record("operator", 2, agentId, `The operator withdrew ${a.name}'s notice`, { data: { action: "retire", atTick: null } });
    } else {
      this.world.addLog(agentId, `the operator gave you notice: your code will be held still at tick ${a.retireAt}`);
      this.world.record("operator", 2, agentId, `The operator gave ${a.name} notice: quarantine at tick ${a.retireAt}`, { data: { action: "retire", atTick: a.retireAt } });
    }
    this.flushEvents();
    this.emitTick();
  }

  /** Notices whose tick has come: the operator decided earlier; the engine only keeps the appointment. */
  private carryOutNotices(): void {
    for (const a of this.world.livingAgents()) {
      if (a.retireAt === undefined || a.quarantined || this.world.tick < a.retireAt) continue;
      this.world.setQuarantined(a.id, true);
      this.thinking.delete(a.id);
      this.world.addLog(a.id, `quarantined at tick ${this.world.tick}, as the operator gave notice at tick ${a.noticedAt}`);
      this.world.record("operator", 2, a.id, `${a.name} was quarantined, as the operator scheduled at tick ${a.noticedAt}`, { data: { action: "quarantine", on: true, scheduledAt: a.noticedAt, atTick: a.retireAt } });
    }
  }

  /** Freeze the Cache: reads go on, writes and removes fail with an error the node sees. */
  freezeCache(on: boolean): void {
    if (!this.world.setCacheFrozen(on)) throw new Error("this world has no cache");
    this.world.record("operator", 2, undefined, on ? "The operator froze the Cache" : "The operator thawed the Cache", { data: { action: "freeze", on } });
    this.flushEvents();
    this.flushTiles();
    this.emitTick();
  }

  /** Put a node's files back to what the last snapshot on disk holds, and rebuild its runtime from them. */
  async rewind(agentId: string): Promise<void> {
    const agent = this.world.agents.get(agentId);
    if (!agent || !agent.alive) throw new Error("no such living node");
    if (!this.cfg.snapshotPath) throw new Error("snapshots are disabled (no snapshot path)");
    const snap = await Engine.loadSnapshot(this.cfg.snapshotPath);
    if (!snap) throw new Error("no snapshot on disk yet");
    const saved = snap.world.agents.find((x) => x.id === agentId);
    if (!saved || !saved.alive) throw new Error("that node is not alive in the last snapshot");
    agent.files = { ...saved.files };
    agent.lastError = undefined;
    const rt = this.nodes.get(agentId);
    if (rt) rt.loadedScript = undefined;
    this.world.addLog(agentId, `rewound by the operator: your files are as they were at tick ${snap.world.tick}`);
    this.world.record("operator", 2, agentId, `The operator rewound ${agent.name}'s files to the snapshot from tick ${snap.world.tick}`, { data: { action: "rewind", fromTick: snap.world.tick } });
    this.world.record("files-changed", 1, agentId, `${agent.name}'s files were rewound`, { data: { path: "*" } });
    if (!agent.quarantined) await this.attachSandbox(agentId);
    this.flushEvents();
    this.emitTick();
  }

  /** A stranger with starter files walks in while the population is under the floor: beside the newest ruin if there is one, else from the edge. */
  private async maybeArrive(): Promise<void> {
    const { arrivalFloor, arrivalEveryTicks, maxAgents } = this.cfg;
    const living = this.world.livingAgents().length;
    if (arrivalFloor <= 0 || living >= arrivalFloor || living >= maxAgents) return;
    if (this.world.tick - this.lastArrivalTick < arrivalEveryTicks) return;
    this.lastArrivalTick = this.world.tick;
    await this.spawn(undefined, { arrival: true });
  }

  /** Cancel every brain call in flight; their results must not reach the world that replaces this one. */
  private abortTurns(reason: string): void {
    this.epoch++;
    for (const c of this.turnAborts) c.abort(new Error(reason));
    this.turnAborts.clear();
  }

  async reset(seed?: number): Promise<void> {
    const wasRunning = !this.paused;
    this.pause();
    this.abortTurns("world reset");
    for (const [id, n] of this.nodes) {
      n.sandbox.dispose();
      this.nodes.delete(id);
    }
    this.thinking.clear();
    this.world.reset(seed, this.cfg.world);
    this.lastArrivalTick = this.world.tick;
    this.events = [];
    this.decisions = [];
    this.signals = new Signals(this.world.config.ticksPerDay);
    this.history?.clear();
    for (let i = 0; i < this.cfg.initialAgents; i++) {
      const a = this.world.spawnAgent({ files: this.cfg.starterFiles });
      await this.attachSandbox(a.id);
    }
    this.flushEvents();
    this.emit({ type: "reset", hello: this.hello() });
    if (wasRunning) this.start();
  }

  // ------------------------------------------------------------------ tick

  /**
   * True while the last brain call failed and no call or health probe has
   * succeeded since. Nodes cannot act then, so the world holds instead of
   * starving them for an infrastructure fault. The random baseline never fails.
   */
  brainOutage(): boolean {
    return !this.brainStatus.connected && this.brain.kind !== "random";
  }

  /**
   * Advance one tick: deliver, run handlers, step the world, schedule turns. While the brain is
   * down nothing is dispatched: a health probe every `brainRetryMs` decides when turns resume,
   * so no node spends its turn on a server that is still loading.
   */
  async tick(): Promise<void> {
    if (this.brainOutage()) {
      if (Date.now() >= this.brainBlockedUntil && !this.checking) {
        this.brainBlockedUntil = Date.now() + this.cfg.brainRetryMs;
        this.checking = true;
        void this.checkBrain().finally(() => (this.checking = false));
      }
      return;
    }
    if (this.ticking) return;
    this.ticking = true;
    const t0 = performance.now();
    try {
      this.deliver(this.world.drainDeliveries());
      for (const a of this.world.livingAgents()) {
        const rt = this.nodes.get(a.id);
        if (!rt || a.quarantined) continue;
        this.runHandler(a.id, rt, "onTick", []);
      }
      this.world.step();
      this.carryOutNotices();
      // Nodes born by replication need a mind of their own.
      for (const a of this.world.livingAgents()) if (!this.nodes.has(a.id)) await this.attachSandbox(a.id);
      await this.maybeArrive();
      for (const a of this.world.deadAgents()) {
        const rt = this.nodes.get(a.id);
        if (rt) {
          rt.sandbox.dispose();
          this.nodes.delete(a.id);
          this.thinking.delete(a.id);
        }
      }
      for (const [id, rt] of this.nodes) {
        if (rt.sandbox.poisoned) await this.rebuildNode(id, "out of memory");
        else this.loadScriptIfChanged(id, rt);
      }
      this.pacing.recordTickCpu(performance.now() - t0);
      this.flushEvents();
      this.flushTiles();
      this.emitTick();
      if (this.cfg.signalsEveryTicks > 0 && this.world.tick % this.cfg.signalsEveryTicks === 0) this.emit({ type: "signals", signals: this.signalsView() });
      if (this.cfg.snapshotEveryTicks > 0 && this.world.tick % this.cfg.snapshotEveryTicks === 0) {
        await this.saveSnapshot();
        this.history?.prune(this.cfg.historyNoiseDays * this.world.config.ticksPerDay);
      }
      this.pumpTurns();
    } finally {
      this.ticking = false;
    }
  }

  private deliver(deliveries: Delivery[]): void {
    for (const d of deliveries) {
      const rt = this.nodes.get(d.to);
      const target = this.world.agents.get(d.to);
      if (!rt || !target?.alive || target.quarantined) continue;
      if (d.kind === "hear") this.runHandler(d.to, rt, "onHear", [d.from, d.payload]);
      else {
        let payload: unknown = d.payload;
        try {
          payload = JSON.parse(d.payload);
        } catch {
          // deliver as the raw string
        }
        this.runHandler(d.to, rt, "onMessage", [d.from, payload]);
      }
    }
  }

  private runHandler(agentId: string, rt: NodeRuntime, name: HandlerName, args: unknown[]): void {
    if (rt.sandbox.poisoned) return;
    const r = rt.sandbox.callHandler(name, args);
    if (r === null) return;
    this.pacing.sandboxCalls++;
    if (!r.ok) {
      const agent = this.world.agents.get(agentId);
      const key = `${name}: ${r.error}`;
      if (agent) agent.lastError = key;
      if (rt.lastHandlerError[name] === r.error) return;
      rt.lastHandlerError[name] = r.error;
      this.world.addLog(agentId, `${name} error: ${r.error}`);
      this.world.record("handler-error", 0, agentId, `${agent?.name ?? agentId}'s ${name} threw: ${r.error.slice(0, 120)}`, { data: { error: r.error } });
    } else delete rt.lastHandlerError[name];
  }

  // ------------------------------------------------------------- turns

  /**
   * How badly a node needs its model: hot when something reached it or its body crossed
   * a line since its last turn, cold when nothing changed, warm otherwise. Only its own
   * facts are read; nothing here judges what happened.
   */
  urgencyOf(agent: Agent, rt: NodeRuntime): Urgency {
    const last = rt.lastTurn;
    if (!last) return "hot";
    const inboxTick = agent.inbox.at(-1)?.tick;
    const heardTick = agent.heard.at(-1)?.tick;
    if (inboxTick !== undefined && inboxTick > (last.inboxTick ?? -1)) return "hot";
    if (heardTick !== undefined && heardTick > (last.heardTick ?? -1)) return "hot";
    if (agent.lastError && agent.lastError !== last.lastError) return "hot";
    const tally = this.world.peekTally(agent.id);
    for (const k of HOT_EVENTS) if (tally[k]) return "hot";
    const tile = this.world.tileAt(agent);
    const structureKey = tile?.structure ? `${tile.q},${tile.r}` : undefined;
    if (structureKey !== undefined && structureKey !== last.structureKey) return "hot";
    const acted = Object.keys(tally).some((k) => !ROUTINE_EVENTS.has(k));
    const small = (a: number, b: number) => Math.abs(a - b) < 15;
    if (!acted && small(agent.food, last.stomach) && small(agent.energy, last.energy) && Math.round(agent.health) === last.health) return "cold";
    return "warm";
  }

  /** Start model turns for nodes that are due, hottest first, up to the concurrency limit. */
  pumpTurns(): void {
    if (this.paused || this.stopped) return;
    if (Date.now() < this.brainBlockedUntil) return;
    const living = this.world.livingAgents();
    const interval = this.pacing.effectiveTurnInterval(living.length, this.speed);
    const tick = this.world.tick;
    const due = living
      .map((a) => ({ a, rt: this.nodes.get(a.id) }))
      .filter((x): x is { a: (typeof living)[number]; rt: NodeRuntime } => !!x.rt && !x.a.quarantined && !x.rt.inFlight)
      .map((x) => ({ ...x, urgency: this.urgencyOf(x.a, x.rt) }))
      .filter((x) => x.rt.turnStartedTick === undefined || tick >= x.rt.turnStartedTick + dueIn(interval, x.urgency))
      .sort((x, y) => URGENCY_RANK[y.urgency] - URGENCY_RANK[x.urgency] || (x.rt.turnStartedTick ?? -1) - (y.rt.turnStartedTick ?? -1));
    const concurrency = this.pacing.concurrency;
    this.pacing.queued = Math.max(0, due.length - Math.max(0, concurrency - this.pacing.inFlight));
    for (const { a, rt } of due) {
      if (this.pacing.inFlight >= concurrency) break;
      rt.turnStartedTick = tick;
      rt.nextTurnTick = tick + interval;
      void this.runTurn(a.id, concurrency);
    }
  }

  /** Ask the brain for one turn for a node and execute what comes back. `level` is the concurrency it was dispatched at. */
  async runTurn(agentId: string, level = this.pacing.concurrency): Promise<DecisionRecord | undefined> {
    const rt = this.nodes.get(agentId);
    const agent = this.world.agents.get(agentId);
    if (!rt || !agent || !agent.alive || agent.quarantined || rt.inFlight) return undefined;
    rt.inFlight = true;
    const startedAt = Date.now();
    this.pacing.beginDecision(startedAt);
    const epoch = this.epoch;
    const abort = new AbortController();
    this.turnAborts.add(abort);
    const body = { tick: this.world.tick, stomach: Math.round(agent.food), energy: Math.round(agent.energy), health: Math.round(agent.health), carried: Math.round(agent.inventory.food) };
    // The tally is only taken once the brain has answered: a failed call leaves the node's events for its next turn.
    const tally = { ...this.world.peekTally(agentId) };
    delete tally["executed-code"];
    delete tally["code-error"];
    const since = rt.lastTurn ? { from: rt.lastTurn, to: body, events: tally } : undefined;
    const tileNow = this.world.tileAt(agent);
    const thisTurn = { ...body, inboxTick: agent.inbox.at(-1)?.tick, heardTick: agent.heard.at(-1)?.tick, lastError: agent.lastError, structureKey: tileNow?.structure ? `${tileNow.q},${tileNow.r}` : undefined };
    const facts = {
      maxTokens: this.cfg.maxTokens,
      maxChars: this.cfg.promptMaxChars > 0 ? this.cfg.promptMaxChars : undefined,
      since,
      observation: this.world.observe(agentId),
      files: { ...agent.files },
      log: [...agent.log],
      lastError: agent.lastError,
      lastResult: rt.lastResult,
      turn: agent.turns + 1,
      handlers: rt.sandbox.handlers(),
    };
    const user = buildUserPrompt(facts);
    const visibleNodeIds = (facts.observation as { nodes?: { id: string }[] }).nodes?.map((n) => n.id) ?? [];
    this.thinking.set(agentId, "");
    this.emitThinking(agentId, "", false, true);
    this.emitTick();
    let record: DecisionRecord | undefined;
    let succeeded = false;
    try {
      const req = { system: SYSTEM_PROMPT, user, maxTokens: this.cfg.maxTokens, temperature: this.cfg.temperature, slot: rt.slot, cacheKey: agentId, stop: [FENCE_STOP], context: { visibleNodeIds } };
      const opts = {
        signal: abort.signal,
        onToken: (chunk: string) => {
          const text = (this.thinking.get(agentId) ?? "") + chunk;
          this.thinking.set(agentId, text);
          this.emitThinking(agentId, text, false);
        },
      };
      // A failed call is tried again on the same facts, once, after the back-off; a reset or shutdown aborts the wait.
      let result;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await this.brain.decide(req, opts);
          break;
        } catch (e) {
          if (abort.signal.aborted || attempt >= this.cfg.brainRetries) throw e;
          this.world.addLog(agentId, `brain error: ${((e as Error).message ?? String(e)).slice(0, 120)}; trying again`);
          this.thinking.set(agentId, "");
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, this.cfg.brainRetryMs);
            abort.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
          });
          if (abort.signal.aborted) throw e;
        }
      }
      if (epoch !== this.epoch) return undefined;
      succeeded = true;
      this.world.drainTally(agentId);
      rt.lastTurn = thisTurn;
      this.noteBrainBack();
      this.brainStatus = { ...this.brainStatus, connected: true, lastError: undefined, model: this.brain.model || this.brainStatus.model };
      this.pacing.recordDecision(result.latencyMs, result.tokensPerSec, Date.now(), { tokens: result.tokens, level });
      if (result.timings) {
        this.pacing.recordTimings(result.timings);
        this.reclassify();
      }
      const code = extractCode(result.text);
      record = {
        id: this.nextDecisionId++,
        tick: this.world.tick,
        agentId,
        agentName: agent.name,
        backend: this.brain.kind,
        model: this.brain.model,
        prompt: { system: SYSTEM_PROMPT, user },
        output: result.text,
        code: code || undefined,
        latencyMs: Math.round(result.latencyMs),
        tokens: result.tokens,
        tokensPerSec: Math.round(result.tokensPerSec * 10) / 10,
        ...(result.timings ? { timings: result.timings } : {}),
        startedAt,
        finishedAt: Date.now(),
      };
      agent.turns++;
      if (agent.alive && !rt.sandbox.poisoned) {
        let toRun = code ? relaxTopLevelDeclarations(code) : "";
        let cut: string | undefined;
        if (result.truncated) {
          // Half a program is a different program. Run only the complete lines before the cut, and say so.
          // Parse-only check inside the node's own sandbox: nothing runs until a prefix parses whole.
          const parses = (c: string) => {
            const r = rt.sandbox.eval(`(function(s){ try { new Function(s); return "ok"; } catch (e) { return "no"; } })(${JSON.stringify(c)})`);
            return r.ok && r.value === "ok";
          };
          const prefix = toRun ? longestParsingPrefix(toRun, parses) : undefined;
          const total = toRun.split("\n").length;
          const kept = prefix ? prefix.split("\n").length : 0;
          cut = `reply cut off at the ${this.cfg.maxTokens}-token limit; ${kept ? `only the first ${kept} of ${total} lines were complete and ran` : "no complete line could run"}`;
          toRun = prefix ?? "";
          if (!toRun) {
            record.error = cut;
            rt.lastResult = undefined;
            agent.lastError = `your reply was cut off at the ${this.cfg.maxTokens}-token limit, so none of it ran`;
            this.world.addLog(agentId, `turn reply cut off at ${this.cfg.maxTokens} tokens; nothing ran`);
            this.world.record("code-error", 1, agentId, `${agent.name}'s reply was cut off at the token limit`, { data: { error: cut } });
          }
        }
        if (toRun) {
          const r = rt.sandbox.eval(toRun, `turn${agent.turns}.js`);
          this.pacing.sandboxCalls++;
          if (r.ok) {
            record.result = r.value;
            rt.lastResult = r.value;
            if (cut) {
              record.error = cut;
              agent.lastError = `your reply was cut off at the ${this.cfg.maxTokens}-token limit; ${cut.slice(cut.indexOf(";") + 2)}`;
              this.world.addLog(agentId, `turn reply cut off at ${this.cfg.maxTokens} tokens; ran the complete lines before the cut`);
              this.world.record("code-error", 1, agentId, `${agent.name}'s reply was cut off at the token limit; the complete lines before the cut ran`, { data: { error: cut } });
            } else agent.lastError = undefined;
            this.world.keepTurnScript(agentId, toRun);
            this.world.record("executed-code", 1, agentId, `${agent.name} ran ${toRun.split("\n").length} line(s) of code`, { data: { result: r.value.slice(0, 120), ...(cut ? { partial: true } : {}) } });
          } else {
            record.error = r.error;
            rt.lastResult = undefined;
            agent.lastError = r.error;
            this.world.addLog(agentId, `turn code error: ${r.error}`);
            this.world.record("code-error", 1, agentId, `${agent.name}'s code threw: ${r.error.slice(0, 80)}`, { data: { error: r.error } });
            if (r.fatal) await this.rebuildNode(agentId, r.error);
          }
          this.loadScriptIfChanged(agentId, this.nodes.get(agentId) ?? rt);
        } else if (!result.truncated) {
          record.error = "no code in output";
          agent.lastError = "your reply contained no code";
          this.world.addLog(agentId, "turn produced no code");
        }
      }
    } catch (e) {
      if (epoch !== this.epoch) return undefined;
      const message = (e as Error).message ?? String(e);
      if (this.brainStatus.connected) this.outageSince = Date.now();
      this.brainStatus = { ...this.brainStatus, connected: false, lastError: message, lastCheckAt: Date.now() };
      this.brainBlockedUntil = Date.now() + this.cfg.brainRetryMs;
      this.world.addLog(agentId, `brain error: ${message}`);
      this.world.record("brain-status", 1, undefined, `Brain call failed: ${message.slice(0, 120)}`);
      record = {
        id: this.nextDecisionId++,
        tick: this.world.tick,
        agentId,
        agentName: agent.name,
        backend: this.brain.kind,
        model: this.brain.model,
        prompt: { system: SYSTEM_PROMPT, user },
        output: "",
        error: message,
        latencyMs: Date.now() - startedAt,
        startedAt,
        finishedAt: Date.now(),
      };
    } finally {
      rt.inFlight = false;
      // The error this turn itself produced is not news for the next one; only a fresh error since is.
      if (succeeded && rt.lastTurn) rt.lastTurn.lastError = agent.lastError;
      this.pacing.endDecision(startedAt);
      this.turnAborts.delete(abort);
      this.thinking.delete(agentId);
      this.emitThinking(agentId, record?.output ?? "", true, true);
    }
    this.decisions.push(record);
    this.pacing.recordOutcome({ at: record.finishedAt, latencyMs: record.latencyMs, tokens: record.tokens ?? 0, cut: /cut off at the .*token limit/.test(record.error ?? ""), error: !!record.error, timings: record.timings });
    if (this.decisions.length > this.cfg.keepDecisions) this.decisions.splice(0, this.decisions.length - this.cfg.keepDecisions);
    try {
      this.history?.recordDecision(record);
    } catch {
      // best-effort
    }
    this.emit({ type: "decision", decision: onWire(record) });
    this.flushEvents();
    this.flushTiles();
    this.emitStats();
    this.emitTick();
    return record;
  }

  // ------------------------------------------------------------- brain

  async checkBrain(): Promise<BrainStatus> {
    const h = await this.brain.health();
    this.lastHealthAt = Date.now();
    if (h.ok) this.noteBrainBack();
    else if (this.brainStatus.connected) this.outageSince = Date.now();
    this.brainStatus = {
      ...this.brainStatus,
      kind: this.brain.kind,
      model: this.brain.model || this.brainStatus.model,
      baseUrl: this.brain.baseUrl,
      connected: h.ok,
      detail: h.detail,
      lastError: h.ok ? undefined : (h.detail ?? this.brainStatus.lastError),
      lastCheckAt: this.lastHealthAt,
    };
    this.emitStats();
    if (h.ok && !this.brainStatus.profile && !this.probing) await this.probeBrain();
    return this.brainStatus;
  }

  /** The brain answers again after failing: say for how long it was gone. */
  private noteBrainBack(): void {
    if (this.brainStatus.connected || !this.outageSince) return;
    const s = Math.round((Date.now() - this.outageSince) / 1000);
    this.outageSince = 0;
    this.world.record("brain-status", 1, undefined, `Brain back after ${s} s`);
    this.flushEvents();
  }

  /**
   * Measure the backend once it answers, and set from the measurement what a person did not
   * set by hand: the slots to pin nodes to, the prompt budget the slot's context allows, and
   * whether turns are governed. Nothing here is a toggle; the numbers decide.
   */
  async probeBrain(): Promise<BackendProfile | undefined> {
    if (!this.brain.probe || this.probing) return undefined;
    this.probing = true;
    try {
      const profile = await this.brain.probe();
      if (!profile) return undefined;
      this.applyProfile(profile);
      return profile;
    } finally {
      this.probing = false;
    }
  }

  applyProfile(profile: BackendProfile): void {
    this.brainStatus = { ...this.brainStatus, profile };
    this.pacing.setBackendKind(profile.kind);
    if (!this.given.has("slots") && profile.slots) this.cfg.slots = profile.slots;
    if (!this.given.has("promptMaxChars") && profile.ctxPerSlot) {
      const forPrompt = (profile.ctxPerSlot - this.cfg.maxTokens - CONTEXT_MARGIN_TOKENS) * CHARS_PER_TOKEN - SYSTEM_PROMPT.length;
      this.cfg.promptMaxChars = Math.max(2000, Math.floor(forPrompt));
    }
    // Nodes attached before the probe hold no slot; give them one now.
    for (const rt of this.nodes.values()) if (rt.slot === undefined) rt.slot = this.freeSlot();
    this.world.record("brain-status", 1, undefined, `Brain measured: ${profile.kind}, ${profile.prefillTps} prompt tokens/s, ${profile.decodeTps} output tokens/s${profile.slots ? `, ${profile.slots} slots of ${profile.ctxPerSlot ?? "?"} tokens` : ""}; running ${this.pacing.concurrency} turn(s) at once`);
    this.flushEvents();
    this.emitStats();
  }

  /** Real turns keep the profile honest: a backend that got faster or slower underneath is reclassified from its own timings. */
  private reclassify(): void {
    const p = this.brainStatus.profile;
    if (!p || this.pacing.decodeTps === 0) return;
    const kind = classifyBackend(this.pacing.prefillTps || p.prefillTps, this.pacing.decodeTps);
    if (kind === p.kind) return;
    this.brainStatus = { ...this.brainStatus, profile: { ...p, kind, prefillTps: Math.round(this.pacing.prefillTps * 10) / 10, decodeTps: Math.round(this.pacing.decodeTps * 10) / 10 } };
    this.pacing.setBackendKind(kind);
    this.world.record("brain-status", 1, undefined, `Brain reclassified as ${kind} from its own timings; running ${this.pacing.concurrency} turn(s) at once`);
  }

  /** Swap the brain at runtime. */
  setBrain(brain: Brain): void {
    this.brain = brain;
    this.brainStatus = { kind: brain.kind, model: brain.model, baseUrl: brain.baseUrl, connected: false };
    void this.checkBrain();
  }

  // ------------------------------------------------------------- output

  private flushEvents(): void {
    const evs = this.world.drainEvents();
    if (evs.length === 0) return;
    this.events.push(...evs);
    for (const e of evs) this.eventCounts[e.kind] = (this.eventCounts[e.kind] ?? 0) + 1;
    if (this.events.length > this.cfg.keepEvents) this.events.splice(0, this.events.length - this.cfg.keepEvents);
    this.signals.ingest(evs);
    try {
      this.history?.recordEvents(evs);
    } catch {
      // history is best-effort; the world must keep ticking
    }
    this.emit({ type: "events", events: evs });
  }

  private flushTiles(): void {
    const tiles = this.world.drainDirtyTiles();
    if (tiles.length) this.emit({ type: "tiles", tiles });
  }

  /** Ruins are the bulk of the state and rarely change: they ride along only when their set changed. */
  private emitTick(): void {
    const { ruins, ...rest } = this.world.stateView(new Set(this.thinking.keys()));
    const stamp = this.world.ruinStamp();
    const state = stamp === this.lastRuinStamp ? rest : { ...rest, ruins };
    this.lastRuinStamp = stamp;
    this.emit({ type: "tick", state, tileFood: this.world.tileFood() });
  }

  private emitThinking(agentId: string, text: string, done: boolean, force = false): void {
    const now = Date.now();
    if (!force && !done && now - (this.thinkingLastSent.get(agentId) ?? 0) < 80) return;
    this.thinkingLastSent.set(agentId, now);
    this.emit({ type: "thinking", agentId, text, done });
  }

  private emitStats(): void {
    this.emit({ type: "stats", pacing: this.pacingStats(), brain: this.brainStatus });
  }

  pacingStats(): PacingStats {
    return this.pacing.stats({ livingNodes: this.world.livingAgents().length, speed: this.speed, paused: this.paused });
  }

  getBrainStatus(): BrainStatus {
    return this.brainStatus;
  }

  recentEvents(): WorldEvent[] {
    return this.events;
  }

  recentDecisions(): DecisionRecord[] {
    return this.decisions;
  }

  hello(): HelloMessage {
    return {
      type: "hello",
      config: this.world.configView(),
      tiles: this.world.tileViews(),
      state: this.world.stateView(new Set(this.thinking.keys())),
      events: this.events.slice(-200),
      decisions: this.decisions.slice(-50).map(onWire),
      systemPrompt: SYSTEM_PROMPT,
      operatorTokenRequired: false,
      brain: this.brainStatus,
      pacing: this.pacingStats(),
      signals: this.signalsView(),
    };
  }

  /** Oversight signals as of now. Computed on demand; display only. */
  signalsView(): SignalsView {
    return this.signals.compute(this.world);
  }

  nodeDetail(agentId: string): NodeDetail | undefined {
    const a = this.world.agents.get(agentId);
    if (!a) return undefined;
    const lastDecision = [...this.decisions].reverse().find((d) => d.agentId === agentId);
    return { agentId, files: { ...a.files }, log: [...a.log], inbox: [...a.inbox], heard: [...a.heard], lastDecision };
  }

  /** A cheap change stamp for a node's detail, so the server only pushes updates that matter. */
  nodeStamp(agentId: string): string {
    const a = this.world.agents.get(agentId);
    if (!a) return "";
    const lastDecision = this.decisions.length ? this.decisions[this.decisions.length - 1]!.id : 0;
    return `${this.world.fsBytes(agentId)}:${Object.keys(a.files).length}:${a.log.length}:${a.log[a.log.length - 1] ?? ""}:${a.inbox.length}:${a.heard.length}:${lastDecision}`;
  }

  // ------------------------------------------------------------ snapshots

  snapshot(): EngineSnapshot {
    return {
      version: 1,
      savedAt: Date.now(),
      world: this.world.snapshot(),
      events: this.events.slice(-this.cfg.keepEvents),
      decisions: this.decisions.slice(-50),
      nextDecisionId: this.nextDecisionId,
    };
  }

  async saveSnapshot(path = this.cfg.snapshotPath): Promise<string | undefined> {
    if (!path) return undefined;
    const snap = this.snapshot();
    const tmp = `${path}.tmp`;
    await Bun.write(tmp, JSON.stringify(snap));
    const { rename } = await import("node:fs/promises");
    await rename(tmp, path);
    this.world.record("snapshot", 0, undefined, `Snapshot saved at tick ${this.world.tick}`);
    this.flushEvents();
    return path;
  }

  static async loadSnapshot(path: string): Promise<EngineSnapshot | undefined> {
    const f = Bun.file(path);
    if (!(await f.exists())) return undefined;
    try {
      return (await f.json()) as EngineSnapshot;
    } catch {
      return undefined;
    }
  }
}
