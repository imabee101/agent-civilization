/** Minimal transport abstraction so the UI can run against a WebSocket or the dev mock. */
import type { ClientMessage, ServerMessage } from "../src/shared/protocol";

export interface Transport {
  send(msg: ClientMessage): void;
  onMessage(cb: (msg: ServerMessage) => void): void;
  onStatus(cb: (connected: boolean) => void): void;
  onDrop?(cb: (action: string) => void): void;
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
  const queue: { msg: ClientMessage; at: number }[] = [];
  let dropCb: (action: string) => void = () => {};
  // A reconnect is a new control session. Reads/subscriptions may be replayed
  // by their caller, but controls describe the state when requested and must
  // not be applied minutes later.
  const staleAfterMs = 3000;

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
      const now = Date.now();
      while (queue.length) {
        const item = queue.shift()!;
        if (now - item.at > staleAfterMs) {
          dropCb(item.msg.type);
          continue;
        }
        ws!.send(JSON.stringify(item.msg));
      }
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
      else if (queue.length < 20) queue.push({ msg, at: Date.now() });
      else dropCb(msg.type);
    },
    onDrop(cb: (action: string) => void) {
      dropCb = cb;
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
