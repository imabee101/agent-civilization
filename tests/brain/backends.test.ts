import { describe, expect, test } from "bun:test";
import { OpenAICompatibleBrain } from "../../src/brain/openai";
import { LlamaCppBrain, formatPrompt } from "../../src/brain/llamacpp";
import { OllamaBrain } from "../../src/brain/ollama";
import { RandomBrain, RANDOM_SNIPPETS } from "../../src/brain/random";
import { BrainError } from "../../src/brain/types";

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

const req = { system: "SYS", user: "USER" };

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
    expect(c.body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);
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
      'data: {"content":"","stop":true,"timings":{"predicted_n":5,"predicted_per_second":42.5}}\n\n',
      'data: {"content":"IGNORED AFTER STOP","stop":false}\n\n',
    ]);
    const brain = new LlamaCppBrain({ kind: "llamacpp", baseUrl: "http://h:8080", fetch, maxTokens: 50 });
    const r = await brain.decide(req);
    expect(r.text).toBe("move(2)");
    expect(r.tokens).toBe(5);
    expect(r.tokensPerSec).toBe(42.5);
    expect(r.estimated).toBe(false);
    const c = captured[0]!;
    expect(c.url).toBe("http://h:8080/completion");
    expect(c.body.prompt).toBe(formatPrompt("chatml", "SYS", "USER"));
    expect(c.body.n_predict).toBe(50);
    expect(c.body.stream).toBe(true);
    expect(c.body.stop).toContain("<|im_end|>");
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
      '{"message":{"content":"\\"hi\\")"},"done":false}\n{"message":{"content":""},"done":true,"eval_count":10,"eval_duration":500000000}\n',
    ]);
    const brain = new OllamaBrain({ kind: "ollama", baseUrl: "http://h:11434", model: "qwen2.5:3b", fetch, maxTokens: 64, temperature: 0.9 });
    const r = await brain.decide(req);
    expect(r.text).toBe('say("hi")');
    expect(r.tokens).toBe(10);
    expect(r.tokensPerSec).toBe(20);
    const c = captured[0]!;
    expect(c.url).toBe("http://h:11434/api/chat");
    expect(c.body.model).toBe("qwen2.5:3b");
    expect(c.body.options).toEqual({ temperature: 0.9, num_predict: 64 });
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
