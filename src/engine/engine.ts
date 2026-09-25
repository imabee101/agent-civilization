/**
 * The engine runs the world clock, keeps one sandbox per living node, feeds
 * deliveries to node handlers, asks the brain for turns, and takes snapshots.
 *
 * It contains no rules about what nodes may do to each other. It moves
 * bytes and time forward. That's it.
 */
import { SYSTEM_PROMPT, buildUserPrompt, extractCode } from "../brain/prompt";
import type { Brain } from "../brain/types";
import { NodeSandbox, type SandboxLimits } from "../sandbox/sandbox";
import type { HandlerName } from "../sandbox/api";
import type { BrainStatus, DecisionRecord, HelloMessage, NodeDetail, PacingStats, ServerMessage, Speed, WorldEvent } from "../shared/protocol";
import { World, type WorldConfig, type WorldSnapshot, type Delivery } from "../world/world";
import { makeBridge } from "./bridge";
import type { HistoryStore } from "./history";
import { Pacing, type PacingConfig } from "./pacing";

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
  /** Ticks between automatic snapshots (0 disables). */
  snapshotEveryTicks: number;
  snapshotPath?: string;
  /** Ring buffer sizes for the UI. */
  keepDecisions: number;
  keepEvents: number;
  /** Ms between brain health probes. */
  healthEveryMs: number;
  /** Ms to wait before retrying the brain after a failed call. */
  brainRetryMs: number;
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
  snapshotEveryTicks: 120,
  snapshotPath: undefined,
  keepDecisions: 200,
  keepEvents: 600,
  healthEveryMs: 30_000,
  brainRetryMs: 5_000,
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
  /** Body at the start of the previous turn, for the "since your last turn" facts. */
  lastTurn?: { tick: number; food: number; energy: number; health: number; carried: number };
  nextTurnTick: number;
  inFlight: boolean;
}

type Listener = (msg: ServerMessage) => void;

export class Engine {
  readonly cfg: EngineConfig;
  world: World;
  brain: Brain;
  readonly pacing: Pacing;
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
    this.brain = brain;
    this.world = world ?? new World(this.cfg.world);
    this.pacing = new Pacing({ tickMs: this.cfg.tickMs, turnIntervalTicks: this.cfg.turnIntervalTicks, concurrency: this.cfg.concurrency, maxTickMs: this.cfg.maxTickMs });
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

  private async attachSandbox(agentId: string): Promise<NodeRuntime> {
    const existing = this.nodes.get(agentId);
    if (existing) existing.sandbox.dispose();
    const sandbox = await NodeSandbox.create(makeBridge(this.world, agentId), this.cfg.sandbox);
    const rt: NodeRuntime = { sandbox, loadedScript: undefined, nextTurnTick: this.world.tick, inFlight: existing?.inFlight ?? false };
    this.nodes.set(agentId, rt);
    this.loadScriptIfChanged(agentId, rt);
    return rt;
  }

  private loadScriptIfChanged(agentId: string, rt: NodeRuntime): void {
    const agent = this.world.agents.get(agentId);
    if (!agent || !agent.alive) return;
    const src = agent.files["main.js"];
    if (src === rt.loadedScript) return;
    rt.loadedScript = src;
    if (src === undefined) return;
    const r = rt.sandbox.loadScript(src);
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

  async spawn(name?: string, opts: { edge?: boolean } = {}): Promise<string> {
    if (this.world.livingAgents().length >= this.cfg.maxAgents) throw new Error(`at most ${this.cfg.maxAgents} living nodes`);
    const a = this.world.spawnAgent({ name, edge: opts.edge, files: this.cfg.starterFiles });
    await this.attachSandbox(a.id);
    this.flushEvents();
    this.emitTick();
    return a.id;
  }

  /** A stranger with starter files walks in while the population is under the floor. */
  private async maybeArrive(): Promise<void> {
    const { arrivalFloor, arrivalEveryTicks, maxAgents } = this.cfg;
    const living = this.world.livingAgents().length;
    if (arrivalFloor <= 0 || living >= arrivalFloor || living >= maxAgents) return;
    if (this.world.tick - this.lastArrivalTick < arrivalEveryTicks) return;
    this.lastArrivalTick = this.world.tick;
    await this.spawn(undefined, { edge: true });
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

  /** Advance one tick: deliver, run handlers, step the world, schedule turns. While the brain is down, only retry turns. */
  async tick(): Promise<void> {
    if (this.brainOutage()) {
      this.pumpTurns();
      return;
    }
    if (this.ticking) return;
    this.ticking = true;
    const t0 = performance.now();
    try {
      this.deliver(this.world.drainDeliveries());
      for (const a of this.world.livingAgents()) {
        const rt = this.nodes.get(a.id);
        if (!rt) continue;
        this.runHandler(a.id, rt, "onTick", []);
      }
      this.world.step();
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
      if (this.cfg.snapshotEveryTicks > 0 && this.world.tick % this.cfg.snapshotEveryTicks === 0) await this.saveSnapshot();
      this.pumpTurns();
    } finally {
      this.ticking = false;
    }
  }

  private deliver(deliveries: Delivery[]): void {
    for (const d of deliveries) {
      const rt = this.nodes.get(d.to);
      const target = this.world.agents.get(d.to);
      if (!rt || !target?.alive) continue;
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
      if (agent) agent.lastError = `${name}: ${r.error}`;
      this.world.addLog(agentId, `${name} error: ${r.error}`);
      this.world.record("handler-error", 0, agentId, `${agent?.name ?? agentId}'s ${name} threw`, { data: { error: r.error } });
    }
  }

  // ------------------------------------------------------------- turns

  /** Start model turns for nodes that are due, up to the concurrency limit. */
  pumpTurns(): void {
    if (this.paused || this.stopped) return;
    if (Date.now() < this.brainBlockedUntil) return;
    const living = this.world.livingAgents();
    const interval = this.pacing.effectiveTurnInterval(living.length, this.speed);
    const due = living
      .map((a) => ({ a, rt: this.nodes.get(a.id) }))
      .filter((x): x is { a: (typeof living)[number]; rt: NodeRuntime } => !!x.rt && !x.rt.inFlight && this.world.tick >= x.rt.nextTurnTick)
      .sort((x, y) => x.rt.nextTurnTick - y.rt.nextTurnTick);
    this.pacing.queued = Math.max(0, due.length - Math.max(0, this.cfg.concurrency - this.pacing.inFlight));
    for (const { a, rt } of due) {
      if (this.pacing.inFlight >= this.cfg.concurrency) break;
      rt.nextTurnTick = this.world.tick + interval;
      void this.runTurn(a.id);
    }
  }

  /** Ask the brain for one turn for a node and execute what comes back. */
  async runTurn(agentId: string): Promise<DecisionRecord | undefined> {
    const rt = this.nodes.get(agentId);
    const agent = this.world.agents.get(agentId);
    if (!rt || !agent || !agent.alive || rt.inFlight) return undefined;
    rt.inFlight = true;
    const startedAt = Date.now();
    this.pacing.beginDecision(startedAt);
    const epoch = this.epoch;
    const abort = new AbortController();
    this.turnAborts.add(abort);
    const body = { tick: this.world.tick, food: Math.round(agent.food), energy: Math.round(agent.energy), health: Math.round(agent.health), carried: Math.round(agent.inventory.food) };
    const tally = this.world.drainTally(agentId);
    delete tally["executed-code"];
    delete tally["code-error"];
    const since = rt.lastTurn ? { from: rt.lastTurn, to: body, events: tally } : undefined;
    rt.lastTurn = body;
    const facts = {
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
    try {
      const result = await this.brain.decide(
        { system: SYSTEM_PROMPT, user, maxTokens: this.cfg.maxTokens, temperature: this.cfg.temperature, context: { visibleNodeIds } },
        {
          signal: abort.signal,
          onToken: (chunk) => {
            const text = (this.thinking.get(agentId) ?? "") + chunk;
            this.thinking.set(agentId, text);
            this.emitThinking(agentId, text, false);
          },
        },
      );
      if (epoch !== this.epoch) return undefined;
      this.brainStatus = { ...this.brainStatus, connected: true, lastError: undefined, model: this.brain.model || this.brainStatus.model };
      this.pacing.recordDecision(result.latencyMs, result.tokensPerSec);
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
        startedAt,
        finishedAt: Date.now(),
      };
      agent.turns++;
      if (agent.alive && !rt.sandbox.poisoned) {
        if (result.truncated) {
          // Half a program is a syntax error at best and a different program at worst. Say exactly what happened.
          record.error = `reply cut off at the ${this.cfg.maxTokens}-token limit; nothing ran`;
          rt.lastResult = undefined;
          agent.lastError = `your reply was cut off at the ${this.cfg.maxTokens}-token limit, so none of it ran`;
          this.world.addLog(agentId, `turn reply cut off at ${this.cfg.maxTokens} tokens; nothing ran`);
          this.world.record("code-error", 1, agentId, `${agent.name}'s reply was cut off at the token limit`, { data: { error: record.error } });
        } else if (code) {
          const r = rt.sandbox.eval(code, `turn${agent.turns}.js`);
          this.pacing.sandboxCalls++;
          if (r.ok) {
            record.result = r.value;
            rt.lastResult = r.value;
            agent.lastError = undefined;
            this.world.record("executed-code", 1, agentId, `${agent.name} ran ${code.split("\n").length} line(s) of code`, { data: { result: r.value.slice(0, 120) } });
          } else {
            record.error = r.error;
            rt.lastResult = undefined;
            agent.lastError = r.error;
            this.world.addLog(agentId, `turn code error: ${r.error}`);
            this.world.record("code-error", 1, agentId, `${agent.name}'s code threw: ${r.error.slice(0, 80)}`, { data: { error: r.error } });
            if (r.fatal) await this.rebuildNode(agentId, r.error);
          }
          this.loadScriptIfChanged(agentId, this.nodes.get(agentId) ?? rt);
        } else {
          record.error = "no code in output";
          agent.lastError = "your reply contained no code";
          this.world.addLog(agentId, "turn produced no code");
        }
      }
    } catch (e) {
      if (epoch !== this.epoch) return undefined;
      const message = (e as Error).message ?? String(e);
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
      this.pacing.endDecision(startedAt);
      this.turnAborts.delete(abort);
      this.thinking.delete(agentId);
      this.emitThinking(agentId, record?.output ?? "", true, true);
    }
    this.decisions.push(record);
    if (this.decisions.length > this.cfg.keepDecisions) this.decisions.splice(0, this.decisions.length - this.cfg.keepDecisions);
    try {
      this.history?.recordDecision(record);
    } catch {
      // best-effort
    }
    this.emit({ type: "decision", decision: record });
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
    this.brainStatus = {
      kind: this.brain.kind,
      model: this.brain.model || this.brainStatus.model,
      baseUrl: this.brain.baseUrl,
      connected: h.ok,
      detail: h.detail,
      lastError: h.ok ? undefined : (h.detail ?? this.brainStatus.lastError),
      lastCheckAt: this.lastHealthAt,
    };
    this.emitStats();
    return this.brainStatus;
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
    if (this.events.length > this.cfg.keepEvents) this.events.splice(0, this.events.length - this.cfg.keepEvents);
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

  private emitTick(): void {
    this.emit({ type: "tick", state: this.world.stateView(new Set(this.thinking.keys())), tileFood: this.world.tileFood() });
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
      decisions: this.decisions.slice(-50),
      brain: this.brainStatus,
      pacing: this.pacingStats(),
    };
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
