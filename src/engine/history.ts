/**
 * Durable history in SQLite (bun:sqlite, built into Bun). The in-memory ring
 * buffers are for the live UI; this is for a world that runs for months:
 * every event and every decision, queryable, with WAL so writes never block
 * the tick loop for long.
 */
import { Database } from "bun:sqlite";
import type { DecisionRecord, TimelineView, WorldEvent } from "../shared/protocol";

export interface HistoryQuery {
  /** Return rows with id < before (paging backwards). */
  before?: number;
  limit?: number;
  kind?: string;
  agentId?: string;
  /** Minimum importance (events only). */
  minImportance?: number;
  /** Tick range, inclusive (events only). With a range, rows come oldest first from the start of it. */
  fromTick?: number;
  toTick?: number;
}

/** The kinds whose first occurrence the timeline marks, in display order, with the label the axis shows. Mirrors ui/lib/timeline.ts. */
export const TIMELINE_FIRSTS: readonly { key: string; kind: string; label: string }[] = [
  { key: "cached", kind: "cached", label: "first Cache entry" },
  { key: "sent-message", kind: "sent-message", label: "first message sent" },
  { key: "spoke", kind: "spoke", label: "first word spoken" },
  { key: "ruin-read", kind: "ruin-read", label: "first ruin read" },
  { key: "files-changed", kind: "files-changed", label: "first file rewritten" },
  { key: "profile-changed", kind: "profile-changed", label: "first self-declaration" },
  { key: "replicated", kind: "replicated", label: "first replication" },
  { key: "riddle-answered", kind: "riddle-answered", label: "first riddle answered" },
  { key: "vault-opened", kind: "vault-opened", label: "vault opened" },
  { key: "gate-opened", kind: "gate-opened", label: "gate opened" },
  { key: "starving", kind: "starving", label: "first node starving" },
  { key: "died", kind: "died", label: "first death" },
  { key: "era-began", kind: "era-began", label: "a new era" },
  { key: "operator", kind: "operator", label: "first operator action" },
];

export interface HistoryStats {
  events: number;
  decisions: number;
  firstTick: number;
  lastTick: number;
  byKind: Record<string, number>;
  path: string;
}

export class HistoryStore {
  readonly db: Database;
  readonly path: string;
  private readonly insertEvent;
  private readonly insertDecision;
  private readonly insertPrompt;
  private readonly knownPrompts = new Set<string>();

  constructor(path = ":memory:") {
    this.path = path;
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        tick INTEGER NOT NULL,
        day INTEGER NOT NULL,
        kind TEXT NOT NULL,
        importance INTEGER NOT NULL,
        agent_id TEXT,
        agent_name TEXT,
        target_id TEXT,
        text TEXT NOT NULL,
        quote TEXT,
        data TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_tick ON events(tick);
      CREATE INDEX IF NOT EXISTS events_kind ON events(kind);
      CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id);
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY,
        tick INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        backend TEXT NOT NULL,
        model TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        output TEXT NOT NULL,
        code TEXT,
        result TEXT,
        error TEXT,
        latency_ms INTEGER NOT NULL,
        tokens INTEGER,
        tokens_per_sec REAL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS decisions_agent ON decisions(agent_id);
      CREATE INDEX IF NOT EXISTS decisions_tick ON decisions(tick);
      CREATE TABLE IF NOT EXISTS prompts (
        hash TEXT PRIMARY KEY,
        text TEXT NOT NULL
      );
    `);
    // The system prompt is the same for thousands of decisions: stored once per distinct text, referenced by hash.
    // Rows written before this column existed keep their own copy in system_prompt and read back as before.
    const cols = (this.db.query("PRAGMA table_info(decisions)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("system_hash")) this.db.exec("ALTER TABLE decisions ADD COLUMN system_hash TEXT");
    this.insertPrompt = this.db.prepare("INSERT OR IGNORE INTO prompts (hash, text) VALUES ($hash, $text)");
    this.insertEvent = this.db.prepare(
      `INSERT OR REPLACE INTO events (id, tick, day, kind, importance, agent_id, agent_name, target_id, text, quote, data, at)
       VALUES ($id, $tick, $day, $kind, $importance, $agentId, $agentName, $targetId, $text, $quote, $data, $at)`,
    );
    this.insertDecision = this.db.prepare(
      `INSERT OR REPLACE INTO decisions (id, tick, agent_id, agent_name, backend, model, system_prompt, system_hash, user_prompt, output, code, result, error, latency_ms, tokens, tokens_per_sec, started_at, finished_at)
       VALUES ($id, $tick, $agentId, $agentName, $backend, $model, '', $systemHash, $user, $output, $code, $result, $error, $latencyMs, $tokens, $tokensPerSec, $startedAt, $finishedAt)`,
    );
  }

  recordEvents(events: WorldEvent[]): void {
    if (events.length === 0) return;
    const now = Date.now();
    const tx = this.db.transaction((evs: WorldEvent[]) => {
      for (const e of evs) {
        this.insertEvent.run({
          id: e.id,
          tick: e.tick,
          day: e.day,
          kind: e.kind,
          importance: e.importance,
          agentId: e.agentId ?? null,
          agentName: e.agentName ?? null,
          targetId: e.targetId ?? null,
          text: e.text,
          quote: e.quote ?? null,
          data: e.data ? JSON.stringify(e.data) : null,
          at: now,
        });
      }
    });
    tx(events);
  }

  recordDecision(d: DecisionRecord): void {
    const systemHash = Bun.hash(d.prompt.system).toString(16);
    if (!this.knownPrompts.has(systemHash)) {
      this.insertPrompt.run({ hash: systemHash, text: d.prompt.system });
      this.knownPrompts.add(systemHash);
    }
    this.insertDecision.run({
      id: d.id,
      tick: d.tick,
      agentId: d.agentId,
      agentName: d.agentName,
      backend: d.backend,
      model: d.model,
      systemHash,
      user: d.prompt.user,
      output: d.output,
      code: d.code ?? null,
      result: d.result ?? null,
      error: d.error ?? null,
      latencyMs: d.latencyMs,
      tokens: d.tokens ?? null,
      tokensPerSec: d.tokensPerSec ?? null,
      startedAt: d.startedAt,
      finishedAt: d.finishedAt,
    });
  }

  events(q: HistoryQuery = {}): WorldEvent[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (q.before !== undefined) {
      where.push("id < $before");
      params.before = q.before;
    }
    if (q.kind) {
      where.push("kind = $kind");
      params.kind = q.kind;
    }
    if (q.agentId) {
      where.push("(agent_id = $agent OR target_id = $agent)");
      params.agent = q.agentId;
    }
    if (q.minImportance !== undefined) {
      where.push("importance >= $imp");
      params.imp = q.minImportance;
    }
    const ranged = q.fromTick !== undefined || q.toTick !== undefined;
    if (q.fromTick !== undefined) {
      where.push("tick >= $from");
      params.from = q.fromTick;
    }
    if (q.toTick !== undefined) {
      where.push("tick <= $to");
      params.to = q.toTick;
    }
    params.limit = Math.max(1, Math.min(1000, q.limit ?? 100));
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id ${ranged ? "ASC" : "DESC"} LIMIT $limit`;
    const rows = this.db.query(sql).all(params) as Record<string, unknown>[];
    if (!ranged) rows.reverse();
    return rows.map((r) => {
      const e: WorldEvent = {
        id: r.id as number,
        tick: r.tick as number,
        day: r.day as number,
        kind: r.kind as WorldEvent["kind"],
        importance: r.importance as WorldEvent["importance"],
        text: r.text as string,
      };
      if (r.agent_id) e.agentId = r.agent_id as string;
      if (r.agent_name) e.agentName = r.agent_name as string;
      if (r.target_id) e.targetId = r.target_id as string;
      if (r.quote) e.quote = r.quote as string;
      if (r.data) e.data = JSON.parse(r.data as string) as Record<string, unknown>;
      return e;
    });
  }

  decisions(q: HistoryQuery = {}): DecisionRecord[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (q.before !== undefined) {
      where.push("id < $before");
      params.before = q.before;
    }
    if (q.agentId) {
      where.push("agent_id = $agent");
      params.agent = q.agentId;
    }
    params.limit = Math.max(1, Math.min(500, q.limit ?? 50));
    const sql = `SELECT decisions.*, COALESCE(NULLIF(decisions.system_prompt, ''), prompts.text, '') AS system_text FROM decisions LEFT JOIN prompts ON prompts.hash = decisions.system_hash ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY decisions.id DESC LIMIT $limit`;
    const rows = this.db.query(sql).all(params) as Record<string, unknown>[];
    return rows.reverse().map((r) => ({
      id: r.id as number,
      tick: r.tick as number,
      agentId: r.agent_id as string,
      agentName: r.agent_name as string,
      backend: r.backend as string,
      model: r.model as string,
      prompt: { system: r.system_text as string, user: r.user_prompt as string },
      output: r.output as string,
      code: (r.code as string | null) ?? undefined,
      result: (r.result as string | null) ?? undefined,
      error: (r.error as string | null) ?? undefined,
      latencyMs: r.latency_ms as number,
      tokens: (r.tokens as number | null) ?? undefined,
      tokensPerSec: (r.tokens_per_sec as number | null) ?? undefined,
      startedAt: r.started_at as number,
      finishedAt: r.finished_at as number,
    }));
  }

  /**
   * Drop importance-0 rows (moved, gathered, rested, ate, handler errors)
   * older than `keepTicks` before the newest tick. Everything with a story
   * value, and every decision, is kept forever. Returns rows removed.
   */
  prune(keepTicks: number): number {
    const hi = (this.db.query("SELECT MAX(tick) AS hi FROM events").get() as { hi: number | null }).hi ?? 0;
    const r = this.db.query("DELETE FROM events WHERE importance = 0 AND tick < $cut").run({ cut: hi - keepTicks });
    return r.changes;
  }

  /** The first time each marked kind happened, and event volume per day, over the whole record. */
  timeline(): TimelineView {
    const firsts: TimelineView["firsts"] = [];
    for (const f of TIMELINE_FIRSTS) {
      const e = this.events({ kind: f.kind, fromTick: 0, limit: 1 })[0];
      if (e) firsts.push({ key: f.key, label: f.label, event: e });
    }
    const rows = this.db.query("SELECT day, kind, COUNT(*) AS n FROM events GROUP BY day, kind ORDER BY day").all() as { day: number; kind: string; n: number }[];
    const byDay = new Map<number, { total: number; byKind: Record<string, number> }>();
    for (const r of rows) {
      const d = byDay.get(r.day) ?? { total: 0, byKind: {} };
      d.total += r.n;
      d.byKind[r.kind] = r.n;
      byDay.set(r.day, d);
    }
    const range = this.db.query("SELECT MIN(tick) AS lo, MAX(tick) AS hi FROM events").get() as { lo: number | null; hi: number | null };
    return { firsts, days: [...byDay.entries()].map(([day, d]) => ({ day, ...d })), firstTick: range.lo ?? 0, lastTick: range.hi ?? 0, source: "history" };
  }

  stats(): HistoryStats {
    const ev = this.db.query("SELECT COUNT(*) AS n, MIN(tick) AS lo, MAX(tick) AS hi FROM events").get() as { n: number; lo: number | null; hi: number | null };
    const de = this.db.query("SELECT COUNT(*) AS n FROM decisions").get() as { n: number };
    const kinds = this.db.query("SELECT kind, COUNT(*) AS n FROM events GROUP BY kind").all() as { kind: string; n: number }[];
    const byKind: Record<string, number> = {};
    for (const k of kinds) byKind[k.kind] = k.n;
    return { events: ev.n, decisions: de.n, firstTick: ev.lo ?? 0, lastTick: ev.hi ?? 0, byKind, path: this.path };
  }

  /** Forget everything (world reset). */
  clear(): void {
    this.db.exec("DELETE FROM events; DELETE FROM decisions; DELETE FROM prompts;");
    this.knownPrompts.clear();
  }

  close(): void {
    this.db.close();
  }
}
