import { describe, expect, test } from "bun:test";
import { OpenAICompatibleBrain, timingsFrom } from "../../src/brain/openai";
import { LlamaCppBrain, formatPrompt } from "../../src/brain/llamacpp";
import { OllamaBrain } from "../../src/brain/ollama";
import { RandomBrain, RANDOM_SNIPPETS } from "../../src/brain/random";
import { BrainError, PROBE_PROMPT, classifyBackend, profileFrom } from "../../src/brain/types";

interface Captured {
  url: string;
  body: any;
  headers: Record<string, string>;
}

/** A fetch that records the request and replies with the given chunks (streamed) or a JSON object. */
function fakeFetch(reply: string[] | object | ((url: string) => Response), captured: Captured[] = []) {
  const f = async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers as Record<string, string>) ?? {} });
    if (typeof reply === "function") return reply(String(url));
    if (Array.isArray(reply)) {
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of reply) c.enqueue(enc.encode(ch));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return Response.json(reply);
  };
  return { fetch: f, captured };
}

const req = { system: "SYS", user: "USER", slot: 4 };

describe("OpenAICompatibleBrain", () => {
  test("reports a reply that stopped at the token limit as truncated", async () => {
    const stream = fakeFetch(['data: {"choices":[{"delta":{"content":"gather("}}]}\n\n', 'data: {"choices":[{"delta":{"content":""},"finish_reason":"length"}],"usage":{"completion_tokens":2}}\n\n', "data: [DONE]\n\n"]);
    const b = new OpenAICompatibleBrain({ kind: "openai", baseUrl: "http://x/v1", fetch: stream.fetch, stream: true });
    const r = await b.decide({ system: "s", user: "u" });
    expect(r.truncated).toBe(true);
    const whole = fakeFetch({ choices: [{ message: { content: "rest()" }, finish_reason: "stop" }] });
    const b2 = new OpenAICompatibleBrain({ kind: "openai", baseUrl: "http://x/v1", fetch: whole.fetch, stream: false });
    expect((await b2.decide({ system: "s", user: "u" })).truncated).toBe(false);
  });

  test("streams SSE deltas, reports usage, sends the right request", async () => {
    const { fetch, captured } = fakeFetch([
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"```js\\n"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"gather()"}}]}\n\ndata: {"choices":[{"delta":{"content":"\\n```"}}],"usage":null}\n\n',
      'data: {"choices":[],"usage":{"completion_tokens":7}}\n\ndata: [DONE]\n\n',
    ]);
    const brain = new OpenAICompatibleBrain({ kind: "openai", baseUrl: "http://h/v1/", model: "m", apiKey: "k", fetch, maxTokens: 99, temperature: 0.2 });
    const tokens: string[] = [];
    const r = await brain.decide(req, { onToken: (t) => tokens.push(t) });
    expect(r.text).toBe("```js\ngather()\n```");
    expect(tokens.join("")).toBe(r.text);
    expect(r.tokens).toBe(7);
    expect(r.estimated).toBe(false);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    const c = captured[0]!;
    expect(c.url).toBe("http://h/v1/chat/completions");
    expect(c.headers.authorization).toBe("Bearer k");
    expect(c.body.model).toBe("m");
    expect(c.body.stream).toBe(true);
    expect(c.body.max_tokens).toBe(99);
    expect(c.body.temperature).toBe(0.2);
    expect(c.body.cache_prompt).toBe(true);
    expect(c.body.id_slot).toBe(4);
    expect(c.body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);
  });

  test("reads llama-server timings and cached tokens, and reports decode-only speed", async () => {
    const final = { choices: [], usage: { completion_tokens: 2, prompt_tokens: 1314, prompt_tokens_details: { cached_tokens: 1300 } }, timings: { cache_n: 1300, prompt_n: 14, prompt_ms: 114.6, predicted_n: 2, predicted_ms: 100 } };
    const stream = fakeFetch(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', `data: ${JSON.stringify(final)}\n\n`, "data: [DONE]\n\n"]);
    const b = new OpenAICompatibleBrain({ kind: "openai", baseUrl: "http://x/v1", fetch: stream.fetch, stream: true });
    const r = await b.decide({ system: "s", user: "u" });
    expect(r.timings).toEqual({ promptTokens: 1314, cachedTokens: 1300, promptMs: 114.6, outputTokens: 2, outputMs: 100 });
    expect(r.tokensPerSec).toBe(20);
    expect(timingsFrom({ choices: [] })).toBeUndefined();
    const whole = fakeFetch({ choices: [{ message: { content: "rest()" }, finish_reason: "stop" }], usage: { completion_tokens: 3 } });
    const b2 = new OpenAICompatibleBrain({ kind: "openai", baseUrl: "http://x/v1", fetch: whole.fetch, stream: false });
    expect((await b2.decide({ system: "s", user: "u" })).timings).toBeUndefined();
  });

  test("sends stop strings and sampling fields only when set, and no cache for a probe", async () => {
    const plain = fakeFetch({ choices: [{ message: { content: "x" } }] });
    await new OpenAICompatibleBrain({ kind: "openai", fetch: plain.fetch, stream: false }).decide({ system: "s", user: "u" });
    expect(plain.captured[0]!.body.stop).toBeUndefined();
    expect("top_p" in plain.captured[0]!.body).toBe(false);
    expect(plain.captured[0]!.body.cache_prompt).toBe(true);
    const set = fakeFetch({ choices: [{ message: { content: "x" } }] });
    await new OpenAICompatibleBrain({ kind: "openai", fetch: set.fetch, stream: false, topP: 0.9, minP: 0.05, repeatPenalty: 1.1 }).decide({ system: "s", user: "u", stop: ["\n```"], noCache: true, topP: 0.8 });
    const body = set.captured[0]!.body;
    expect(body.stop).toEqual(["\n```"]);
    expect(body).toMatchObject({ top_p: 0.8, min_p: 0.05, repeat_penalty: 1.1, cache_prompt: false });
  });

  test("probe reads /props beside /v1 and times one uncached request", async () => {
    const { fetch, captured } = fakeFetch((url) => {
      if (url.endsWith("/props")) return Response.json({ total_slots: 12, model_path: "/m/tiny-Q4_0.gguf", model_ftype: "Q4_0", default_generation_settings: { n_ctx: 6144 } });
      return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { completion_tokens: 2, prompt_tokens: 200 }, timings: { cache_n: 0, prompt_n: 200, prompt_ms: 2000, predicted_n: 16, predicted_ms: 1000 } });
    });
    const b = new OpenAICompatibleBrain({ kind: "openai", baseUrl: "http://x/v1", fetch, stream: false });
    const p = (await b.probe())!;
    expect(captured[0]!.url).toBe("http://x/props");
    expect(captured[1]!.body.cache_prompt).toBe(false);
    expect(captured[1]!.body.messages[1].content).toBe(PROBE_PROMPT);
    expect(p).toMatchObject({ kind: "bandwidth-bound", prefillTps: 100, decodeTps: 16, slots: 12, ctxPerSlot: 6144, cacheable: true, modelFile: "tiny-Q4_0.gguf", quant: "Q4_0" });
    // No /props (another server): the timed request alone still yields a profile.
    const bare = fakeFetch((url) => (url.endsWith("/props") ? new Response("no", { status: 404 }) : Response.json({ choices: [{ message: { content: "ok" } }], usage: { completion_tokens: 16 } })));
    const q = (await new OpenAICompatibleBrain({ kind: "openai", baseUrl: "http://y/v1", fetch: bare.fetch, stream: false }).probe())!;
    expect(q.slots).toBeUndefined();
    expect(q.cacheable).toBe(false);
    // A dead server: undefined, never a throw.
    const dead = fakeFetch(() => new Response("", { status: 503 }));
    expect(await new OpenAICompatibleBrain({ kind: "openai", fetch: dead.fetch, stream: false }).probe()).toBeUndefined();
  });

  test("non-streaming mode parses message content and estimates tokens when usage is missing", async () => {
    const { fetch, captured } = fakeFetch({ choices: [{ message: { role: "assistant", content: "rest()" } }] });
    const brain = new OpenAICompatibleBrain({ kind: "openai", fetch, stream: false });
    const r = await brain.decide(req);
    expect(r.text).toBe("rest()");
    expect(r.estimated).toBe(true);
    expect(r.tokens).toBeGreaterThan(0);
    expect(captured[0]!.body.stream).toBe(false);
    expect(captured[0]!.body.stream_options).toBeUndefined();
  });

  test("propagates HTTP errors as BrainError", async () => {
    const { fetch } = fakeFetch(() => new Response("nope", { status: 404 }));
    const brain = new OpenAICompatibleBrain({ kind: "openai", fetch });
    await expect(brain.decide(req)).rejects.toBeInstanceOf(BrainError);
  });

  test("health lists models and adopts the first when none configured", async () => {
    const { fetch } = fakeFetch({ data: [{ id: "qwen2.5:3b" }, { id: "other" }] });
    const brain = new OpenAICompatibleBrain({ kind: "openai", fetch });
    const h = await brain.health();
    expect(h.ok).toBe(true);
    expect(h.models).toEqual(["qwen2.5:3b", "other"]);
    expect(brain.model).toBe("qwen2.5:3b");
  });

  test("health reports failure without throwing", async () => {
    const brain = new OpenAICompatibleBrain({
      kind: "openai",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const h = await brain.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("ECONNREFUSED");
  });
});

describe("classifyBackend", () => {
  test("fast needs both rates; a CPU-class decode rate is bandwidth-bound whatever the prefill", () => {
    expect(classifyBackend(1500, 70)).toBe("fast");
    expect(classifyBackend(120, 17)).toBe("bandwidth-bound");
    expect(classifyBackend(1500, 20)).toBe("bandwidth-bound");
    expect(classifyBackend(200, 60)).toBe("bandwidth-bound");
    const p = profileFrom({ text: "", latencyMs: 1000, tokens: 16, tokensPerSec: 16, estimated: true }, {}, 5);
    expect(p).toEqual({ kind: "bandwidth-bound", prefillTps: 0, decodeTps: 16, cacheable: false, probedAt: 5 });
  });
});

describe("LlamaCppBrain", () => {
  test("formats prompts for each template", () => {
    expect(formatPrompt("chatml", "S", "U")).toBe("<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nU<|im_end|>\n<|im_start|>assistant\n");
    expect(formatPrompt("llama3", "S", "U")).toContain("<|start_header_id|>assistant<|end_header_id|>");
    expect(formatPrompt("plain", "S", "U")).toBe("S\n\nU\n\nResponse:\n");
  });

  test("streams /completion SSE and uses reported timings", async () => {
    const { fetch, captured } = fakeFetch([
      'data: {"content":"move(","stop":false}\n\n',
      'data: {"content":"2)","stop":false}\n\n',
      'data: {"content":"","stop":true,"stop_type":"limit","timings":{"cache_n":100,"prompt_n":40,"prompt_ms":400,"predicted_n":5,"predicted_ms":200,"predicted_per_second":42.5}}\n\n',
      'data: {"content":"IGNORED AFTER STOP","stop":false}\n\n',
    ]);
    const brain = new LlamaCppBrain({ kind: "llamacpp", baseUrl: "http://h:8080", fetch, maxTokens: 50 });
    const r = await brain.decide({ ...req, stop: ["\n```"] });
    expect(r.text).toBe("move(2)");
    expect(r.tokens).toBe(5);
    expect(r.tokensPerSec).toBe(42.5);
    expect(r.estimated).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.timings).toEqual({ promptTokens: 140, cachedTokens: 100, promptMs: 400, outputTokens: 5, outputMs: 200 });
    const c = captured[0]!;
    expect(c.url).toBe("http://h:8080/completion");
    expect(c.body.prompt).toBe(formatPrompt("chatml", "SYS", "USER"));
    expect(c.body.n_predict).toBe(50);
    expect(c.body.stream).toBe(true);
    expect(c.body.stop).toContain("<|im_end|>");
    expect(c.body.stop).toContain("\n```");
    expect(c.body.id_slot).toBe(4);
  });

  test("non-streaming parses a single object", async () => {
    const { fetch } = fakeFetch({ content: "eat(5)", tokens_predicted: 3 });
    const brain = new LlamaCppBrain({ kind: "llamacpp", fetch, stream: false, promptFormat: "llama3" });
    const r = await brain.decide(req);
    expect(r.text).toBe("eat(5)");
    expect(r.tokens).toBe(3);
  });

  test("health uses /health and picks up the model name from /props", async () => {
    const { fetch } = fakeFetch((url) => (url.endsWith("/health") ? Response.json({ status: "ok" }) : Response.json({ model_path: "/models/tiny-3b-q4.gguf" })));
    const brain = new LlamaCppBrain({ kind: "llamacpp", fetch });
    const h = await brain.health();
    expect(h.ok).toBe(true);
    expect(brain.model).toBe("tiny-3b-q4.gguf");
  });

  test("health reports a loading server as not ok", async () => {
    const { fetch } = fakeFetch(() => Response.json({ status: "loading model" }));
    const brain = new LlamaCppBrain({ kind: "llamacpp", fetch });
    expect((await brain.health()).ok).toBe(false);
  });
});

describe("OllamaBrain", () => {
  test("streams NDJSON and computes tokens/sec from eval_duration", async () => {
    const { fetch, captured } = fakeFetch([
      '{"message":{"role":"assistant","content":"say("},"done":false}\n',
      '{"message":{"content":"\\"hi\\")"},"done":false}\n{"message":{"content":""},"done":true,"done_reason":"stop","eval_count":10,"eval_duration":500000000,"prompt_eval_count":30,"prompt_eval_duration":300000000}\n',
    ]);
    const brain = new OllamaBrain({ kind: "ollama", baseUrl: "http://h:11434", model: "qwen2.5:3b", fetch, maxTokens: 64, temperature: 0.9 });
    const r = await brain.decide({ ...req, stop: ["\n```"] });
    expect(r.text).toBe('say("hi")');
    expect(r.tokens).toBe(10);
    expect(r.tokensPerSec).toBe(20);
    expect(r.truncated).toBe(false);
    expect(r.timings).toEqual({ promptTokens: 30, cachedTokens: 0, promptMs: 300, outputTokens: 10, outputMs: 500 });
    const c = captured[0]!;
    expect(c.url).toBe("http://h:11434/api/chat");
    expect(c.body.model).toBe("qwen2.5:3b");
    expect(c.body.options).toEqual({ temperature: 0.9, num_predict: 64, stop: ["\n```"] });
    expect(c.body.messages[1]).toEqual({ role: "user", content: "USER" });
  });

  test("refuses to decide with no model", async () => {
    const { fetch } = fakeFetch({});
    const brain = new OllamaBrain({ kind: "ollama", fetch });
    await expect(brain.decide(req)).rejects.toThrow(/no model/);
  });

  test("health lists tags and adopts the first model", async () => {
    const { fetch } = fakeFetch({ models: [{ name: "llama3.2:3b" }] });
    const brain = new OllamaBrain({ kind: "ollama", fetch });
    const h = await brain.health();
    expect(h.ok).toBe(true);
    expect(brain.model).toBe("llama3.2:3b");
    const empty = new OllamaBrain({ kind: "ollama", fetch: fakeFetch({ models: [] }).fetch });
    expect((await empty.health()).ok).toBe(false);
  });
});

describe("RandomBrain", () => {
  test("is deterministic for a seed and returns a fenced snippet", async () => {
    const a = new RandomBrain({ seed: 1 });
    const b = new RandomBrain({ seed: 1 });
    const ra = await a.decide(req);
    const rb = await b.decide(req);
    expect(ra.text).toBe(rb.text);
    expect(ra.text.startsWith("```js\n")).toBe(true);
  });

  test("is uniform over snippets: every option shows up at roughly equal rates", async () => {
    const brain = new RandomBrain({ seed: 7 });
    const counts = new Map<string, number>();
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const r = await brain.decide({ ...req, context: { visibleNodeIds: ["n1"] } });
      const code = r.text.split("\n")[1]!;
      const key = code.replace(/"[^"]*"/g, '"S"').replace(/\d+/g, "N");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(RANDOM_SNIPPETS.length);
    const expected = N / RANDOM_SNIPPETS.length;
    for (const [, n] of counts) {
      expect(n).toBeGreaterThan(expected * 0.7);
      expect(n).toBeLessThan(expected * 1.3);
    }
  });

  test("never emits send() when no node is visible", async () => {
    const brain = new RandomBrain({ seed: 3 });
    for (let i = 0; i < 500; i++) {
      const r = await brain.decide(req);
      expect(r.text.includes("send(")).toBe(false);
    }
  });
});
