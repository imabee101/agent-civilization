import { describe, expect, test } from "bun:test";
import { brainConfigFromEnv, brainKinds, createBrain, registerBrain, resolveBrain } from "../../src/brain/registry";
import { RandomBrain } from "../../src/brain/random";
import type { Brain } from "../../src/brain/types";

describe("registry", () => {
  test("built-in kinds exist and aliases resolve", () => {
    for (const k of ["openai", "llamacpp", "ollama", "random", "llama.cpp", "lmstudio", "none"]) expect(brainKinds()).toContain(k);
    expect(createBrain({ kind: "llama.cpp" }).kind).toBe("llamacpp");
    expect(createBrain({ kind: "LMSTUDIO" }).baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(createBrain({ kind: "none" })).toBeInstanceOf(RandomBrain);
  });

  test("unknown kinds throw with the list of known ones", () => {
    expect(() => createBrain({ kind: "gpt-9000" })).toThrow(/unknown brain kind/);
  });

  test("custom backends can be registered", async () => {
    class Custom implements Brain {
      kind = "custom";
      model = "m";
      async decide() {
        return { text: "```js\nrest()\n```", latencyMs: 1, tokens: 1, tokensPerSec: 1, estimated: true };
      }
      async health() {
        return { ok: true };
      }
    }
    registerBrain("custom", () => new Custom());
    const b = createBrain({ kind: "custom" });
    expect((await b.decide({ system: "", user: "" })).text).toContain("rest()");
  });

  test("brainConfigFromEnv reads AGENTCIV_* with OPENAI_* fallbacks", () => {
    const cfg = brainConfigFromEnv({
      AGENTCIV_BRAIN: "llamacpp",
      AGENTCIV_BASE_URL: "http://gpu:8080",
      AGENTCIV_MODEL: "tiny",
      AGENTCIV_MAX_TOKENS: "300",
      AGENTCIV_TEMPERATURE: "0.4",
      AGENTCIV_STREAM: "false",
      AGENTCIV_TIMEOUT_MS: "9000",
      AGENTCIV_PROMPT_FORMAT: "llama3",
    });
    expect(cfg).toEqual({ kind: "llamacpp", baseUrl: "http://gpu:8080", model: "tiny", apiKey: undefined, maxTokens: 300, temperature: 0.4, stream: false, timeoutMs: 9000, promptFormat: "llama3" });
    const fb = brainConfigFromEnv({ OPENAI_BASE_URL: "http://x/v1", OPENAI_API_KEY: "sk", AGENTCIV_PROMPT_FORMAT: "bogus" });
    expect(fb.kind).toBeUndefined();
    expect(fb.baseUrl).toBe("http://x/v1");
    expect(fb.apiKey).toBe("sk");
    expect(fb.promptFormat).toBeUndefined();
    expect(brainConfigFromEnv({}).maxTokens).toBeUndefined();
  });

  test("resolveBrain: explicit kind wins", async () => {
    const { brain, autodetected } = await resolveBrain({ kind: "random", seed: 1 });
    expect(brain.kind).toBe("random");
    expect(autodetected).toBe(false);
  });

  test("resolveBrain: a bare base URL means OpenAI-compatible", async () => {
    const { brain } = await resolveBrain({ baseUrl: "http://somewhere/v1" });
    expect(brain.kind).toBe("openai");
    expect(brain.baseUrl).toBe("http://somewhere/v1");
  });

  test("resolveBrain: autodetects the first healthy local server", async () => {
    const probed: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      const u = String(url);
      probed.push(u);
      if (u.startsWith("http://127.0.0.1:8080/health")) return Response.json({ status: "ok" });
      if (u.startsWith("http://127.0.0.1:8080/props")) return Response.json({ model_path: "x.gguf" });
      throw new Error("ECONNREFUSED");
    };
    const { brain, autodetected } = await resolveBrain({}, { fetch: fetchImpl });
    expect(autodetected).toBe(true);
    expect(brain.kind).toBe("llamacpp");
    expect(brain.model).toBe("x.gguf");
    expect(probed.some((u) => u.includes("11434"))).toBe(true);
  });

  test("resolveBrain: falls back to random when nothing answers", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const logs: string[] = [];
    const { brain, autodetected } = await resolveBrain({}, { fetch: fetchImpl, log: (m) => logs.push(m) });
    expect(brain.kind).toBe("random");
    expect(autodetected).toBe(true);
    expect(logs.at(-1)).toContain("uniform-random");
  });
});
