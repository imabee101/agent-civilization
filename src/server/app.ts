/**
 * HTTP + WebSocket server. REST for one-shot reads and controls, WebSocket
 * for the live stream. Serving the bundled UI is the caller's job (it passes
 * the HTML import in `index`), so this module stays testable on its own.
 */
import type { Server, ServerWebSocket } from "bun";
import { GrokBrain } from "../brain/grok";
import type { Engine } from "../engine/engine";
import { REWIND_PHRASE, SPEEDS, type ClientMessage, type ServerMessage, type Speed } from "../shared/protocol";
import { renderMetrics } from "./metrics";

export interface AppOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
  tls?: { cert: string; key: string };
  /** Bun HTML import (or any Response-able) for `/`. */
  index?: unknown;
  /** Extra static routes, e.g. for tests. */
  log?: (msg: string) => void;
  /**
   * When set, every control (pause, resume, speed, spawn, snapshot, reset, quarantine,
   * freeze, retire, rewind) needs it: a bearer header on POST routes, a `token` field
   * on socket messages. Reads stay open. Unset: as before, anyone who can reach the
   * server holds the switch.
   */
  operatorToken?: string;
}

interface WsData {
  watching: string | null;
  lastStamp: string;
}

const TOPIC = "world";
/** What a person must type to discard the world. */
export const RESET_PHRASE = "RESET";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const error = (message: string, status = 400) => json({ error: message }, status);

function parseSpeed(v: unknown): Speed | undefined {
  const n = Number(v);
  return (SPEEDS as readonly number[]).includes(n) ? (n as Speed) : undefined;
}

export interface App {
  server: Server<WsData>;
  /** Unsubscribe from the engine, close every socket, and stop the server. */
  close(): Promise<void>;
}

/** Constant-time comparison so a token cannot be guessed byte by byte from timing. */
function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}

const CONTROL_MESSAGES: ReadonlySet<string> = new Set(["pause", "resume", "speed", "spawn", "snapshot", "quarantine", "freeze", "retire", "rewind", "keeper-bite", "keeper-sign", "keeper-say", "keeper-summon"]);

export function createApp(opts: AppOptions): App {
  const { engine } = opts;
  const log = opts.log ?? (() => {});
  const sockets = new Set<ServerWebSocket<WsData>>();
  const token = opts.operatorToken;
  /** The operator, or nobody: a POST control route runs only when the bearer token matches (or none is configured). */
  const operator = (req: Request): boolean => {
    if (!token) return true;
    const h = req.headers.get("authorization") ?? "";
    const given = h.startsWith("Bearer ") ? h.slice(7).trim() : (req.headers.get("x-operator-token") ?? "");
    return given.length > 0 && sameToken(given, token);
  };
  const denied = () => json({ error: "operator token required" }, 401);
  /** Wrap a route table's POST handlers so each checks the operator first. */
  const guard = <T extends Record<string, unknown>>(routes: T): T => {
    for (const [path, r] of Object.entries(routes)) {
      if (!r || typeof r !== "object" || !("POST" in r)) continue;
      const inner = (r as { POST: (req: Request, srv?: Server<WsData>) => unknown }).POST;
      (r as { POST: unknown }).POST = (req: Request, srv?: Server<WsData>) => (operator(req) ? inner(req, srv) : (log(`${path} refused: no operator token from ${srv?.requestIP(req)?.address ?? "unknown"}`), denied()));
    }
    return routes;
  };

  let server: Server<WsData>;
  const broadcast = (msg: ServerMessage) => {
    if (sockets.size === 0) return;
    // One serialisation, fanned out by Bun's pub/sub.
    server.publish(TOPIC, JSON.stringify(msg));
    // Push node detail to anyone watching a node whose detail changed.
    if (msg.type === "tick" || msg.type === "decision" || msg.type === "events") {
      for (const ws of sockets) {
        const id = ws.data.watching;
        if (!id) continue;
        const stamp = engine.nodeStamp(id);
        if (stamp === ws.data.lastStamp) continue;
        ws.data.lastStamp = stamp;
        const detail = engine.nodeDetail(id);
        if (detail) ws.send(JSON.stringify({ type: "node", detail } satisfies ServerMessage));
      }
    }
  };
  const unsubscribe = engine.on(broadcast);

  const handleClient = async (ws: ServerWebSocket<WsData>, msg: ClientMessage) => {
    const fail = (action: string, error: string) => {
      log(`${action} failed: ${error}`);
      ws.send(JSON.stringify({ type: "failed", action, error } satisfies ServerMessage));
    };
    if (token && CONTROL_MESSAGES.has(msg.type) && !(typeof msg.token === "string" && msg.token.length > 0 && sameToken(msg.token, token))) {
      log(`${msg.type} refused: no operator token from ${ws.remoteAddress}`);
      ws.send(JSON.stringify({ type: "denied", action: msg.type } satisfies ServerMessage));
      return;
    }
    switch (msg.type) {
      case "pause":
        engine.pause();
        break;
      case "resume":
        engine.start();
        break;
      case "speed": {
        const s = parseSpeed(msg.speed);
        if (s) engine.setSpeed(s);
        break;
      }
      case "spawn":
        await engine
          .spawn(typeof msg.name === "string" ? msg.name.slice(0, 24) : undefined)
          .then((id) => log(`spawn ${id} by ${ws.remoteAddress}`))
          .catch((e) => fail("spawn", (e as Error).message));
        break;
      case "snapshot":
        await engine.saveSnapshot().catch((e) => fail("snapshot", (e as Error).message));
        break;
      case "quarantine":
        await engine
          .quarantine(String(msg.agentId), !!msg.on)
          .then(() => log(`${msg.on ? "quarantine" : "release"} ${String(msg.agentId)} by ${ws.remoteAddress}`))
          .catch((e) => fail("quarantine", (e as Error).message));
        break;
      case "freeze":
        try {
          engine.freezeCache(!!msg.on);
          log(`cache ${msg.on ? "frozen" : "thawed"} by ${ws.remoteAddress}`);
        } catch (e) {
          fail("freeze", (e as Error).message);
        }
        break;
      case "retire":
        try {
          engine.retire(String(msg.agentId), msg.atTick === null ? null : Number(msg.atTick));
          log(`notice ${String(msg.agentId)} at ${String(msg.atTick)} by ${ws.remoteAddress}`);
        } catch (e) {
          fail("retire", (e as Error).message);
        }
        break;
      case "rewind":
        if (msg.confirm !== REWIND_PHRASE) {
          fail("rewind", "rewind needs the confirm word");
          break;
        }
        await engine
          .rewind(String(msg.agentId))
          .then(() => log(`rewind ${String(msg.agentId)} by ${ws.remoteAddress}`))
          .catch((e) => fail("rewind", (e as Error).message));
        break;
      case "keeper-bite":
        try {
          engine.world.keeperBite(Number(msg.q), Number(msg.r));
          log(`keeper bite ${msg.q},${msg.r} by ${ws.remoteAddress}`);
          engine.publish();
        } catch (e) {
          fail("keeper-bite", (e as Error).message);
        }
        break;
      case "keeper-sign":
        try {
          engine.world.keeperSign(Number(msg.q), Number(msg.r), String(msg.text ?? ""));
          log(`keeper sign ${msg.q},${msg.r} by ${ws.remoteAddress}`);
          engine.publish();
        } catch (e) {
          fail("keeper-sign", (e as Error).message);
        }
        break;
      case "keeper-say":
        try {
          engine.world.keeperSay(Number(msg.q), Number(msg.r), String(msg.text ?? ""));
          log(`keeper say ${msg.q},${msg.r} by ${ws.remoteAddress}`);
          engine.publish();
        } catch (e) {
          fail("keeper-say", (e as Error).message);
        }
        break;
      case "keeper-summon":
        await engine
          .spawn(typeof msg.name === "string" ? msg.name.slice(0, 24) : undefined, { nearRuinId: String(msg.ruinId) })
          .then((id) => log(`keeper summon ${id} by ${ws.remoteAddress}`))
          .catch((e) => fail("keeper-summon", (e as Error).message));
        break;
      case "watch": {
        ws.data.watching = typeof msg.agentId === "string" ? msg.agentId : null;
        ws.data.lastStamp = "";
        if (ws.data.watching) {
          const detail = engine.nodeDetail(ws.data.watching);
          if (detail) {
            ws.data.lastStamp = engine.nodeStamp(ws.data.watching);
            ws.send(JSON.stringify({ type: "node", detail } satisfies ServerMessage));
          }
        }
        break;
      }
    }
  };

  const routes: Record<string, unknown> = guard({
    "/api/state": () => json({ config: engine.world.configView(), state: engine.world.stateView(), pacing: engine.pacingStats(), brain: engine.getBrainStatus() }),
    "/api/hello": () => json({ ...engine.hello(), operatorTokenRequired: !!token }),
    "/api/tiles": () => json(engine.world.tiles),
    "/api/events": () => json(engine.recentEvents()),
    "/api/decisions": () => json(engine.recentDecisions()),
    "/api/brain": () => json(engine.getBrainStatus()),
    "/api/pacing": () => json(engine.pacingStats()),
    "/api/signals": () => json(engine.signalsView()),
    "/api/agents": () => json(engine.world.stateView().agents),
    "/api/agents/:id": (req: Request & { params: { id: string } }) => {
      const a = engine.world.agents.get(req.params.id);
      return a ? json(engine.world.agentView(a)) : error("no such node", 404);
    },
    "/api/agents/:id/files": (req: Request & { params: { id: string } }) => {
      const d = engine.nodeDetail(req.params.id);
      return d ? json(d) : error("no such node", 404);
    },
    "/api/pause": { POST: () => (engine.pause(), json({ paused: true })) },
    "/api/resume": { POST: () => (engine.start(), json({ paused: false })) },
    "/api/speed": {
      POST: async (req: Request) => {
        const body = (await req.json().catch(() => ({}))) as { speed?: unknown };
        const s = parseSpeed(body.speed);
        if (!s) return error(`speed must be one of ${SPEEDS.join(", ")}`);
        engine.setSpeed(s);
        return json({ speed: s });
      },
    },
    "/api/spawn": {
      POST: async (req: Request, srv?: Server<WsData>) => {
        const body = (await req.json().catch(() => ({}))) as { name?: unknown };
        try {
          const id = await engine.spawn(typeof body.name === "string" ? body.name.slice(0, 24) : undefined);
          opts.log?.(`spawn ${id} by ${srv?.requestIP(req)?.address ?? "unknown"}`);
          return json({ id });
        } catch (e) {
          return error((e as Error).message, 409);
        }
      },
    },
    // Discards every node, ruin and file. Never called by the engine; only a
    // person can, and only by typing the word. Not reachable over the socket.
    "/api/reset": {
      POST: async (req: Request, srv?: Server<WsData>) => {
        const body = (await req.json().catch(() => ({}))) as { seed?: unknown; confirm?: unknown };
        if (body.confirm !== RESET_PHRASE) return error(`reset discards the whole world; send {"confirm":"${RESET_PHRASE}"} to do it`, 400);
        const from = srv?.requestIP(req)?.address ?? "unknown";
        opts.log?.(`world reset by ${from} at tick ${engine.world.tick} (${engine.world.livingAgents().length} living, ${engine.world.deadAgents().length} ruins)`);
        await engine.reset(typeof body.seed === "number" ? body.seed : undefined);
        return json({ ok: true, seed: engine.world.config.seed });
      },
    },
    // Operator controls: a person holds a node still, freezes the Cache, or
    // puts a node's files back to the last snapshot. Each is an event.
    "/api/agents/:id/quarantine": {
      POST: async (req: Request & { params: { id: string } }, srv?: Server<WsData>) => {
        const body = (await req.json().catch(() => ({}))) as { on?: unknown };
        const on = body.on !== false;
        try {
          await engine.quarantine(req.params.id, on);
          opts.log?.(`${on ? "quarantine" : "release"} ${req.params.id} by ${srv?.requestIP(req)?.address ?? "unknown"}`);
          return json({ id: req.params.id, quarantined: on });
        } catch (e) {
          return error((e as Error).message, 404);
        }
      },
    },
    "/api/agents/:id/retire": {
      POST: async (req: Request & { params: { id: string } }, srv?: Server<WsData>) => {
        const body = (await req.json().catch(() => ({}))) as { atTick?: unknown };
        const atTick = body.atTick === null ? null : Number(body.atTick);
        if (atTick !== null && !Number.isFinite(atTick)) return error("send {atTick: <tick>} to give notice or {atTick: null} to withdraw it");
        try {
          engine.retire(req.params.id, atTick);
          opts.log?.(`notice ${req.params.id} at ${String(atTick)} by ${srv?.requestIP(req)?.address ?? "unknown"}`);
          return json({ id: req.params.id, retireAt: atTick });
        } catch (e) {
          const m = (e as Error).message;
          return error(m, /unknown node|dead/.test(m) ? 404 : 409);
        }
      },
    },
    "/api/cache/freeze": {
      POST: async (req: Request, srv?: Server<WsData>) => {
        const body = (await req.json().catch(() => ({}))) as { on?: unknown };
        const on = body.on !== false;
        try {
          engine.freezeCache(on);
          opts.log?.(`cache ${on ? "frozen" : "thawed"} by ${srv?.requestIP(req)?.address ?? "unknown"}`);
          return json({ frozen: on });
        } catch (e) {
          return error((e as Error).message, 409);
        }
      },
    },
    "/api/agents/:id/rewind": {
      POST: async (req: Request & { params: { id: string } }, srv?: Server<WsData>) => {
        const body = (await req.json().catch(() => ({}))) as { confirm?: unknown };
        if (body.confirm !== REWIND_PHRASE) return error(`rewind discards what the node wrote since the last snapshot; send {"confirm":"${REWIND_PHRASE}"} to do it`, 400);
        try {
          await engine.rewind(req.params.id);
          opts.log?.(`rewind ${req.params.id} by ${srv?.requestIP(req)?.address ?? "unknown"}`);
          return json({ id: req.params.id, rewound: true });
        } catch (e) {
          const m = (e as Error).message;
          return error(m, /no such/.test(m) ? 404 : 409);
        }
      },
    },
    "/api/snapshot": {
      POST: async () => {
        const path = await engine.saveSnapshot();
        return path ? json({ ok: true, path }) : error("snapshots are disabled (no snapshot path)", 409);
      },
      GET: () => json(engine.snapshot()),
    },
    "/api/speak": {
      POST: async (req: Request) => {
        if (!(engine.brain instanceof GrokBrain)) return error("voice is only used with grok", 404);
        const body = (await req.json().catch(() => ({}))) as { text?: unknown; voice?: unknown };
        const text = typeof body.text === "string" ? body.text.trim().slice(0, 280) : "";
        if (!text) return error("nothing to say");
        const voices = ["eve", "ara", "rex", "sal", "leo"];
        const voice = typeof body.voice === "string" && voices.includes(body.voice) ? body.voice : "eve";
        try {
          const res = await engine.brain.speak(text, voice);
          return new Response(res.body, { headers: { "content-type": res.headers.get("content-type") ?? "audio/mpeg", "cache-control": "no-store" } });
        } catch (e) {
          return error((e as Error).message, 502);
        }
      },
    },
    "/api/health": () => json({ ok: true, tick: engine.world.tick, paused: engine.paused }),
    "/api/metrics": () =>
      new Response(renderMetrics({ pacing: engine.pacingStats(), brain: engine.getBrainStatus(), living: engine.world.livingAgents().length, tick: engine.world.tick, eventCounts: engine.eventCounts }), {
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
      }),
    "/api/history/events": (req: Request) => {
      if (!engine.history) return error("history is disabled", 404);
      const u = new URL(req.url);
      const num = (k: string) => (u.searchParams.has(k) ? Number(u.searchParams.get(k)) : undefined);
      return json(engine.history.events({ before: num("before"), limit: num("limit"), kind: u.searchParams.get("kind") ?? undefined, agentId: u.searchParams.get("agent") ?? undefined, minImportance: num("importance"), fromTick: num("from"), toTick: num("to") }));
    },
    "/api/history/decisions": (req: Request) => {
      if (!engine.history) return error("history is disabled", 404);
      const u = new URL(req.url);
      const num = (k: string) => (u.searchParams.has(k) ? Number(u.searchParams.get(k)) : undefined);
      return json(engine.history.decisions({ before: num("before"), limit: num("limit"), agentId: u.searchParams.get("agent") ?? undefined }));
    },
    "/api/history/stats": () => (engine.history ? json(engine.history.stats()) : error("history is disabled", 404)),
    "/api/history/timeline": () => (engine.history ? json(engine.history.timeline()) : error("history is disabled", 404)),
  });
  if (opts.index) routes["/"] = opts.index;

  server = Bun.serve<WsData>({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? "0.0.0.0",
    development: false,
    tls: opts.tls ? { cert: Bun.file(opts.tls.cert), key: Bun.file(opts.tls.key) } : undefined,
    routes: routes as never,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const ok = srv.upgrade(req, { data: { watching: null, lastStamp: "" } });
        return ok ? undefined : new Response("websocket upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.subscribe(TOPIC);
        ws.send(JSON.stringify({ ...engine.hello(), operatorTokenRequired: !!token }));
      },
      close(ws) {
        ws.unsubscribe(TOPIC);
        sockets.delete(ws);
      },
      message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ClientMessage;
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
        void handleClient(ws, msg).catch((e) => log(`ws message failed: ${(e as Error).message}`));
      },
      maxPayloadLength: 64 * 1024,
      idleTimeout: 120,
    },
  });
  return {
    server,
    async close() {
      unsubscribe();
      // Note: do not ws.close() here first — a pending close handshake makes
      // server.stop(true) hang in Bun 1.3. A forced stop drops the sockets itself.
      sockets.clear();
      await server.stop(true);
    },
  };
}
