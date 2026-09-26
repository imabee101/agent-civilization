import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrokBrain, type GrokAuth } from "../../src/brain/grok";
import { createBrain } from "../../src/brain/registry";

interface Captured {
  url: string;
  body: any;
  headers: Record<string, string>;
}

const sse = (events: object[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
const delta = (d: string) => ({ type: "response.output_text.delta", delta: d });
const completed = (extra: object = {}) => ({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 3564, input_tokens_details: { cached_tokens: 3456 }, output_tokens: 42, cost_in_usd_ticks: 76_000_000 }, ...extra } });

/** A fetch that answers each call with the next reply: SSE events streamed in two chunks, or a status code. */
function fakeFetch(replies: (object[] | number)[]) {
  const captured: Captured[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    const r = replies[Math.min(captured.length - 1, replies.length - 1)]!;
    if (typeof r === "number") return new Response("denied", { status: r });
    const text = sse(r);
    const enc = new TextEncoder();
    const mid = Math.floor(text.length / 2);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(text.slice(0, mid)));
          c.enqueue(enc.encode(text.slice(mid)));
          c.close();
        },
      }),
      { status: 200 },
    );
  };
  return { fetch: f, captured };
}

const hourFromNow = () => Date.now() + 3_600_000;
/** Hands out the tokens in order: the next one after each refresh. */
function authStub(tokens: GrokAuth[]) {
  let i = 0;
  const refreshes: number[] = [];
  return {
    auth: async () => tokens[Math.min(i, tokens.length - 1)],
    refresh: async () => {
      refreshes.push(Date.now());
      i++;
    },
    refreshes,
  };
}

describe("GrokBrain", () => {
  test("is registered as grok", () => {
    expect(createBrain({ kind: "grok" }).kind).toBe("grok");
  });

  test("defaults to the fast Grok 4.6 configuration", async () => {
    const f = fakeFetch([[delta("ok"), completed()]]);
    const b = new GrokBrain({ kind: "grok", fetch: f.fetch, ...authStub([{ token: "T", expiresAt: hourFromNow() }]) });
    await b.decide({ system: "", user: "u" });
    expect(f.captured[0]!.body).toMatchObject({ model: "grok-4.6", reasoning: { effort: "low" } });
  });

  test("streams text, reports usage, cached tokens and cost", async () => {
    const f = fakeFetch([[{ type: "response.created" }, delta("```js\n"), delta("rest();\n```"), completed()]]);
    const a = authStub([{ token: "T1", expiresAt: hourFromNow() }]);
    const b = new GrokBrain({ kind: "grok", fetch: f.fetch, ...a });
    const tokens: string[] = [];
    const r = await b.decide({ system: "SYS", user: "USER" }, { onToken: (t) => tokens.push(t) });
    expect(tokens.join("")).toBe("```js\nrest();\n```");
    expect(r.text).toBe("```js\nrest();\n```");
    expect(r.tokens).toBe(42);
    expect(r.timings).toMatchObject({ promptTokens: 3564, cachedTokens: 3456, promptMs: 0, outputMs: 0 });
    expect(b.costUsd).toBeCloseTo(0.0076);
    expect(a.refreshes.length).toBe(0);
  });

  test("keeps a node's turns under one cache key and sends only our messages", async () => {
    const f = fakeFetch([[delta("ok"), completed()]]);
    const b = new GrokBrain({ kind: "grok", model: "grok-4.6", reasoningEffort: "medium", temperature: 0.9, fetch: f.fetch, ...authStub([{ token: "T1", expiresAt: hourFromNow() }]) });
    await b.decide({ system: "SYS", user: "USER", cacheKey: "n7" });
    const c = f.captured[0]!;
    expect(c.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(c.headers.authorization).toBe("Bearer T1");
    expect(c.headers["x-grok-conv-id"]).toBe("agentciv-n7");
    expect(c.body).toMatchObject({ model: "grok-4.6", prompt_cache_key: "agentciv-n7", reasoning: { effort: "medium" }, temperature: 0.9, store: false, stream: true });
    expect(c.body.input).toEqual([
      { type: "message", role: "system", content: "SYS" },
      { type: "message", role: "user", content: "USER" },
    ]);
  });

  test("two nodes do not share a prompt cache key", async () => {
    const f = fakeFetch([[delta("a"), completed()], [delta("b"), completed()]]);
    const b = new GrokBrain({ kind: "grok", fetch: f.fetch, ...authStub([{ token: "T", expiresAt: hourFromNow() }]) });
    await b.decide({ system: "SYS", user: "USER", cacheKey: "n1" });
    await b.decide({ system: "SYS", user: "USER", cacheKey: "n2" });
    expect(f.captured[0]!.body.prompt_cache_key).toBe("agentciv-n1");
    expect(f.captured[1]!.body.prompt_cache_key).toBe("agentciv-n2");
    expect(f.captured[0]!.headers["x-grok-conv-id"]).not.toBe(f.captured[1]!.headers["x-grok-conv-id"]);
  });

  test("cuts at a stop string, even one split across deltas, and shows nothing past it", async () => {
    const f = fakeFetch([[delta("```js\nrest();\n`"), delta("``\nprose after"), delta("more"), completed()]]);
    const b = new GrokBrain({ kind: "grok", fetch: f.fetch, ...authStub([{ token: "T", expiresAt: hourFromNow() }]) });
    const tokens: string[] = [];
    const r = await b.decide({ system: "", user: "u", stop: ["\n```"] }, { onToken: (t) => tokens.push(t) });
    expect(r.text).toBe("```js\nrest();");
    expect(tokens.join("")).toBe("```js\nrest();");
  });

  test("refreshes a token near expiry before use, and once more after a 401", async () => {
    const near = authStub([{ token: "OLD", expiresAt: Date.now() + 60_000 }, { token: "NEW", expiresAt: hourFromNow() }]);
    const f1 = fakeFetch([[delta("ok"), completed()]]);
    await new GrokBrain({ kind: "grok", fetch: f1.fetch, ...near }).decide({ system: "", user: "u" });
    expect(near.refreshes.length).toBe(1);
    expect(f1.captured[0]!.headers.authorization).toBe("Bearer NEW");

    const revoked = authStub([{ token: "OLD", expiresAt: hourFromNow() }, { token: "NEW", expiresAt: hourFromNow() }]);
    const f2 = fakeFetch([401, [delta("ok"), completed()]]);
    const r = await new GrokBrain({ kind: "grok", fetch: f2.fetch, ...revoked }).decide({ system: "", user: "u" });
    expect(r.text).toBe("ok");
    expect(f2.captured.map((c) => c.headers.authorization)).toEqual(["Bearer OLD", "Bearer NEW"]);
  });

  test("a failed response, a missing sign-in, or an empty reply is a BrainError", async () => {
    const auth = authStub([{ token: "T", expiresAt: hourFromNow() }]);
    const failed = new GrokBrain({ kind: "grok", fetch: fakeFetch([[{ type: "response.failed", response: { error: { message: "rate limited" } } }]]).fetch, ...auth });
    await expect(failed.decide({ system: "", user: "u" })).rejects.toThrow("grok: rate limited");
    const signedOut = new GrokBrain({ kind: "grok", fetch: fakeFetch([[completed()]]).fetch, auth: async () => undefined, refresh: async () => {} });
    await expect(signedOut.decide({ system: "", user: "u" })).rejects.toThrow("no token in");
    expect((await signedOut.health()).ok).toBe(false);
    const empty = new GrokBrain({ kind: "grok", fetch: fakeFetch([[delta("  "), completed()]]).fetch, ...auth });
    await expect(empty.decide({ system: "", user: "u" })).rejects.toThrow("empty reply");
  });

  test("a given token file is read on every call and nothing is run to refresh it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "grok-auth-")), "auth.json");
    const write = (key: string, inMs: number) => writeFileSync(path, JSON.stringify({ "issuer::id": { key, expires_at: new Date(Date.now() + inMs).toISOString() } }));
    write("A", 60_000);
    const f = fakeFetch([[delta("ok"), completed()]]);
    const b = new GrokBrain({ kind: "grok", authFile: path, command: "/nonexistent/grok", fetch: f.fetch });
    await b.decide({ system: "", user: "u" });
    write("B", 3_600_000);
    await b.decide({ system: "", user: "u" });
    expect(f.captured.map((c) => c.headers.authorization)).toEqual(["Bearer A", "Bearer B"]);
  });

  test("probe classes a hosted model as fast and skips the cache", async () => {
    const f = fakeFetch([[delta("ok"), completed()]]);
    const p = await new GrokBrain({ kind: "grok", fetch: f.fetch, ...authStub([{ token: "T", expiresAt: hourFromNow() }]) }).probe();
    expect(p?.kind).toBe("fast");
    expect(f.captured[0]!.body.prompt_cache_key).toBeUndefined();
  });

  test("speak calls the voice endpoint once, and only when asked", async () => {
    const f = fakeFetch([[completed()]]);
    const b = new GrokBrain({ kind: "grok", fetch: f.fetch, ...authStub([{ token: "T", expiresAt: hourFromNow() }]) });
    expect(f.captured).toHaveLength(0);
    const res = await b.speak("hello there", "ara");
    expect(res.ok).toBe(true);
    expect(f.captured).toHaveLength(1);
    expect(f.captured[0]!.url).toBe("https://api.x.ai/v1/tts");
    expect(f.captured[0]!.body).toMatchObject({ text: "hello there", voice_id: "ara", language: "en" });
  });
});
