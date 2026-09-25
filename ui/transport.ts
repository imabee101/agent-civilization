/** Minimal transport abstraction so the UI can run against a WebSocket or the dev mock. */
import type { ClientMessage, ServerMessage } from "../src/shared/protocol";

export interface Transport {
  send(msg: ClientMessage): void;
  onMessage(cb: (msg: ServerMessage) => void): void;
  onStatus(cb: (connected: boolean) => void): void;
  close(): void;
}

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export function createWebSocketTransport(url = wsUrl()): Transport {
  let ws: WebSocket | null = null;
  let msgCb: (m: ServerMessage) => void = () => {};
  let statusCb: (c: boolean) => void = () => {};
  let closed = false;
  let backoff = 500;
  const queue: ClientMessage[] = [];

  const connect = () => {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      setTimeout(connect, backoff);
      return;
    }
    ws.onopen = () => {
      backoff = 500;
      statusCb(true);
      while (queue.length) ws!.send(JSON.stringify(queue.shift()));
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as ServerMessage;
        if (m && typeof m === "object" && typeof (m as { type?: unknown }).type === "string") msgCb(m);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      statusCb(false);
      ws = null;
      if (!closed) {
        setTimeout(connect, backoff);
        backoff = Math.min(8000, backoff * 1.7);
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  };
  connect();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else if (queue.length < 20) queue.push(msg);
    },
    onMessage(cb) {
      msgCb = cb;
    },
    onStatus(cb) {
      statusCb = cb;
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}
