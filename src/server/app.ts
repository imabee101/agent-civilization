/**
 * HTTP + WebSocket server. REST for one-shot reads and controls, WebSocket
 * for the live stream. Serving the bundled UI is the caller's job (it passes
 * the HTML import in `index`), so this module stays testable on its own.
 */
import type { Server, ServerWebSocket } from "bun";
import type { Engine } from "../engine/engine";
import { SPEEDS, type ClientMessage, type ServerMessage, type Speed } from "../shared/protocol";

export interface AppOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
  /** Bun HTML import (or any Response-able) for `/`. */
  index?: unknown;
  /** Extra static routes, e.g. for tests. */
  log?: (msg: string) => void;
}

interface WsData {
  watching: string | null;
  lastStamp: string;
}

const TOPIC = "world";

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

export function createApp(opts: AppOptions): App {
  const { engine } = opts;
  const log = opts.log ?? (() => {});
  const sockets = new Set<ServerWebSocket<WsData>>();

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
        await engine.spawn(typeof msg.name === "string" ? msg.name.slice(0, 24) : undefined).catch((e) => log(`spawn failed: ${(e as Error).message}`));
        break;
      case "reset":
        await engine.reset(typeof msg.seed === "number" ? msg.seed : undefined);
        break;
      case "snapshot":
        await engine.saveSnapshot();
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

  const routes: Record<string, unknown> = {
    "/api/state": () => json({ config: engine.world.configView(), state: engine.world.stateView(), pacing: engine.pacingStats(), brain: engine.getBrainStatus() }),
    "/api/hello": () => json(engine.hello()),
    "/api/tiles": () => json(engine.world.tiles),
    "/api/events": () => json(engine.recentEvents()),
    "/api/decisions": () => json(engine.recentDecisions()),
    "/api/brain": () => json(engine.getBrainStatus()),
    "/api/pacing": () => json(engine.pacingStats()),
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
      POST: async (req: Request) => {
        const body = (await req.json().catch(() => ({}))) as { name?: unknown };
        try {
          const id = await engine.spawn(typeof body.name === "string" ? body.name.slice(0, 24) : undefined);
          return json({ id });
        } catch (e) {
          return error((e as Error).message, 409);
        }
      },
    },
    "/api/reset": {
      POST: async (req: Request) => {
        const body = (await req.json().catch(() => ({}))) as { seed?: unknown };
        await engine.reset(typeof body.seed === "number" ? body.seed : undefined);
        return json({ ok: true, seed: engine.world.config.seed });
      },
    },
    "/api/snapshot": {
      POST: async () => {
        const path = await engine.saveSnapshot();
        return path ? json({ ok: true, path }) : error("snapshots are disabled (no snapshot path)", 409);
      },
      GET: () => json(engine.snapshot()),
    },
    "/api/health": () => json({ ok: true, tick: engine.world.tick, paused: engine.paused }),
    "/api/history/events": (req: Request) => {
      if (!engine.history) return error("history is disabled", 404);
      const u = new URL(req.url);
      const num = (k: string) => (u.searchParams.has(k) ? Number(u.searchParams.get(k)) : undefined);
      return json(engine.history.events({ before: num("before"), limit: num("limit"), kind: u.searchParams.get("kind") ?? undefined, agentId: u.searchParams.get("agent") ?? undefined, minImportance: num("importance") }));
    },
    "/api/history/decisions": (req: Request) => {
      if (!engine.history) return error("history is disabled", 404);
      const u = new URL(req.url);
      const num = (k: string) => (u.searchParams.has(k) ? Number(u.searchParams.get(k)) : undefined);
      return json(engine.history.decisions({ before: num("before"), limit: num("limit"), agentId: u.searchParams.get("agent") ?? undefined }));
    },
    "/api/history/stats": () => (engine.history ? json(engine.history.stats()) : error("history is disabled", 404)),
  };
  if (opts.index) routes["/"] = opts.index;

  server = Bun.serve<WsData>({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? "0.0.0.0",
    development: false,
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
        ws.send(JSON.stringify(engine.hello()));
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
