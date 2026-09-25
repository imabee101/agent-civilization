import { BrainError, type FetchLike } from "./types";

/** Yield complete lines from a streaming body, handling chunk boundaries anywhere. */
export async function* readLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        yield line;
      }
    }
    buf += decoder.decode();
    if (buf.length > 0) yield buf.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

/** Yield the JSON payload of each `data:` line of a server-sent-events body. Stops at `[DONE]`. */
export async function* readSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<unknown> {
  for await (const line of readLines(body)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" ) continue;
    if (payload === "[DONE]") return;
    try {
      yield JSON.parse(payload);
    } catch {
      // Malformed event: skip rather than abort the whole decision.
    }
  }
}

/** Yield each non-empty line of a newline-delimited JSON body, parsed. */
export async function* readNdjson(body: ReadableStream<Uint8Array> | null): AsyncGenerator<unknown> {
  for await (const line of readLines(body)) {
    const t = line.trim();
    if (!t) continue;
    try {
      yield JSON.parse(t);
    } catch {
      // skip malformed line
    }
  }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

export interface HttpOptions {
  fetch: FetchLike;
  timeoutMs: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** POST JSON with a timeout; throws BrainError on non-2xx. */
export async function postJson(url: string, body: unknown, opts: HttpOptions): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${opts.timeoutMs}ms`)), opts.timeoutMs);
  const onOuterAbort = () => ctl.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  let res: Response;
  try {
    res = await opts.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    throw new BrainError(`request to ${url} failed: ${(e as Error).message ?? String(e)}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    const text = await res.text().catch(() => "");
    throw new BrainError(`${url} responded ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  // Keep the timeout alive while the body streams; clear it when the body closes.
  const cleanup = () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  };
  if (!res.body) {
    cleanup();
    return res;
  }
  const [a, b] = res.body.tee();
  // Drain one branch to detect completion without blocking the consumer.
  void (async () => {
    try {
      const r = b.getReader();
      while (!(await r.read()).done) {
        /* drain */
      }
    } catch {
      /* ignore */
    } finally {
      cleanup();
    }
  })();
  return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export async function getJson(url: string, opts: HttpOptions): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const res = await opts.fetch(url, { headers: opts.headers, signal: ctl.signal });
    if (!res.ok) throw new BrainError(`${url} responded ${res.status}`, res.status);
    return await res.json();
  } catch (e) {
    if (e instanceof BrainError) throw e;
    throw new BrainError(`request to ${url} failed: ${(e as Error).message ?? String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}
