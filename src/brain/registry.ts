/**
 * Brain registry and configuration. Add a backend by registering a factory:
 *
 *   registerBrain("mine", (cfg) => new MyBrain(cfg));
 *
 * then run with AGENTCIV_BRAIN=mine. Nothing else in the engine cares.
 */
import { LlamaCppBrain } from "./llamacpp";
import { OllamaBrain } from "./ollama";
import { OpenAICompatibleBrain } from "./openai";
import { RandomBrain } from "./random";
import type { Brain, BrainConfig, FetchLike } from "./types";

export type BrainFactory = (cfg: BrainConfig) => Brain;

const factories = new Map<string, BrainFactory>();

export function registerBrain(kind: string, factory: BrainFactory): void {
  factories.set(kind, factory);
}

export function brainKinds(): string[] {
  return [...factories.keys()];
}

registerBrain("openai", (cfg) => new OpenAICompatibleBrain(cfg));
registerBrain("llamacpp", (cfg) => new LlamaCppBrain(cfg));
registerBrain("ollama", (cfg) => new OllamaBrain(cfg));
registerBrain("random", (cfg) => new RandomBrain(cfg));
// Friendly aliases.
registerBrain("llama.cpp", (cfg) => new LlamaCppBrain(cfg));
registerBrain("llama-server", (cfg) => new LlamaCppBrain(cfg));
registerBrain("lmstudio", (cfg) => new OpenAICompatibleBrain({ baseUrl: "http://127.0.0.1:1234/v1", ...cfg }));
registerBrain("vllm", (cfg) => new OpenAICompatibleBrain({ baseUrl: "http://127.0.0.1:8000/v1", ...cfg }));
registerBrain("none", (cfg) => new RandomBrain(cfg));

export function createBrain(cfg: BrainConfig): Brain {
  const f = factories.get(cfg.kind.toLowerCase());
  if (!f) throw new Error(`unknown brain kind "${cfg.kind}". Known: ${brainKinds().join(", ")}`);
  return f(cfg);
}

/** Read configuration from environment variables (AGENTCIV_*), with a few common fallbacks. */
export function brainConfigFromEnv(env: Record<string, string | undefined> = process.env): Partial<BrainConfig> & { kind?: string } {
  const num = (v: string | undefined) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const bool = (v: string | undefined) => (v === undefined || v === "" ? undefined : !/^(0|false|no|off)$/i.test(v));
  const format = env.AGENTCIV_PROMPT_FORMAT;
  return {
    kind: env.AGENTCIV_BRAIN?.trim() || undefined,
    baseUrl: env.AGENTCIV_BASE_URL || env.OPENAI_BASE_URL || undefined,
    model: env.AGENTCIV_MODEL || env.OPENAI_MODEL || undefined,
    apiKey: env.AGENTCIV_API_KEY || env.OPENAI_API_KEY || undefined,
    maxTokens: num(env.AGENTCIV_MAX_TOKENS),
    temperature: num(env.AGENTCIV_TEMPERATURE),
    stream: bool(env.AGENTCIV_STREAM),
    timeoutMs: num(env.AGENTCIV_TIMEOUT_MS),
    promptFormat: format === "chatml" || format === "llama3" || format === "plain" ? format : undefined,
  };
}

export interface AutodetectCandidate {
  kind: string;
  baseUrl: string;
}

/** Local servers we try, in order, when no backend is configured. */
export const AUTODETECT_CANDIDATES: readonly AutodetectCandidate[] = [
  { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
  { kind: "llamacpp", baseUrl: "http://127.0.0.1:8080" },
  { kind: "openai", baseUrl: "http://127.0.0.1:1234/v1" },
  { kind: "openai", baseUrl: "http://127.0.0.1:8000/v1" },
];

/**
 * Resolve a Brain: explicit kind wins; otherwise probe local servers; otherwise
 * the random baseline. Never throws for missing servers.
 */
export async function resolveBrain(
  partial: Partial<BrainConfig> & { kind?: string },
  opts: { fetch?: FetchLike; candidates?: readonly AutodetectCandidate[]; log?: (msg: string) => void } = {},
): Promise<{ brain: Brain; autodetected: boolean }> {
  const log = opts.log ?? (() => {});
  if (partial.kind) {
    const brain = createBrain({ ...partial, kind: partial.kind, fetch: partial.fetch ?? opts.fetch });
    return { brain, autodetected: false };
  }
  if (partial.baseUrl) {
    // A base URL without a kind: assume OpenAI-compatible, the widest dialect.
    const brain = createBrain({ ...partial, kind: "openai", fetch: partial.fetch ?? opts.fetch });
    return { brain, autodetected: false };
  }
  for (const c of opts.candidates ?? AUTODETECT_CANDIDATES) {
    const brain = createBrain({ ...partial, kind: c.kind, baseUrl: c.baseUrl, fetch: partial.fetch ?? opts.fetch, timeoutMs: 2000 });
    const h = await brain.health();
    if (h.ok) {
      log(`brain: found ${c.kind} at ${c.baseUrl} (${h.detail ?? ""})`);
      // Re-create with the real timeout now that we know it's there.
      return { brain: createBrain({ ...partial, kind: c.kind, baseUrl: c.baseUrl, model: partial.model ?? brain.model, fetch: partial.fetch ?? opts.fetch }), autodetected: true };
    }
    log(`brain: no ${c.kind} at ${c.baseUrl}`);
  }
  log("brain: nothing configured or detected; using the uniform-random baseline");
  return { brain: createBrain({ ...partial, kind: "random" }), autodetected: true };
}
