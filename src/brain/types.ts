import type { BackendKind, BackendProfile, BackendTimings } from "../shared/protocol";

/**
 * A Brain turns a situation into text. That's all it is. Any backend that can
 * do that — an OpenAI-compatible server, llama.cpp's native API, Ollama, or a
 * random-snippet generator — can drive nodes.
 */

export interface DecisionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** Backend slot to run this node's turns in, so the node's own context stays in that slot's KV cache between turns. */
  slot?: number;
  /** Sampling overrides; only sent when set. */
  topP?: number;
  minP?: number;
  repeatPenalty?: number;
  /** Strings at which generation stops; the text stops before them. */
  stop?: string[];
  /** Stable per node: hosted backends keep a node's turns under this key so its unchanged prefix is served from cache. */
  cacheKey?: string;
  /** Do not reuse a cached prefix for this request (probes measure raw prefill). */
  noCache?: boolean;
  /** Sampler seed for backends that take one. Omitted by the others. */
  seed?: number;
  /** Optional structured hints for non-model brains (e.g. random) that can't read the prompt. */
  context?: {
    visibleNodeIds?: string[];
  };
}

export type { BackendKind, BackendProfile, BackendTimings };

export interface DecisionResult {
  /** Raw output text, verbatim. */
  text: string;
  latencyMs: number;
  /** Completion tokens if the backend reported them; otherwise an estimate. */
  tokens: number;
  tokensPerSec: number;
  /** True when `tokens` was estimated rather than reported. */
  estimated: boolean;
  /** True when the backend stopped at the token budget rather than at the model's own end. */
  truncated?: boolean;
  timings?: BackendTimings;
}

/**
 * What kind of backend this is, decided from what it measures, never from a flag:
 * a bandwidth-bound one (a CPU, or a GPU too small for its model) loses throughput
 * when turns run in parallel and is governed; a fast one is left alone.
 * Single-stream rates at or above both of these count as fast.
 */
export const FAST_DECODE_TPS = 25;
export const FAST_PREFILL_TPS = 300;

export function classifyBackend(prefillTps: number, decodeTps: number): BackendKind {
  return decodeTps >= FAST_DECODE_TPS && prefillTps >= FAST_PREFILL_TPS ? "fast" : "bandwidth-bound";
}

/** A prompt long enough that prefill speed is measured on a real batch, not on request overhead. */
export const PROBE_PROMPT = ("The hex world has tiles of grass, rock, sand and water; a node stands on one tile, gathers food, eats, rests, and speaks to nodes within a few hexes. ").repeat(12) + "\nReply with the single word ok.";

export interface DecideOptions {
  onToken?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface Brain {
  readonly kind: string;
  readonly model: string;
  readonly baseUrl?: string;
  decide(req: DecisionRequest, opts?: DecideOptions): Promise<DecisionResult>;
  /** Cheap liveness probe. Should never throw. */
  health(): Promise<{ ok: boolean; detail?: string; models?: string[] }>;
  /**
   * Measure the backend: what the server says about itself (slots, context) and one timed
   * request for raw prefill and decode rates. Costs a few seconds once. Undefined when the
   * backend cannot be measured (the random baseline). Should never throw.
   */
  probe?(): Promise<BackendProfile | undefined>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BrainConfig {
  /** Registered backend kind: "openai" | "llamacpp" | "ollama" | "grok" | "random" | custom. */
  kind: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  minP?: number;
  repeatPenalty?: number;
  stream?: boolean;
  /** Whole-request timeout. */
  timeoutMs?: number;
  /** Extra headers for HTTP backends. */
  headers?: Record<string, string>;
  /** Prompt format for backends that take raw text (llama.cpp /completion). */
  promptFormat?: "chatml" | "llama3" | "plain";
  /** Injectable fetch for tests. */
  fetch?: FetchLike;
  /** Seed for deterministic non-model brains. */
  seed?: number;
  /** Executable for CLI backends (grok). */
  command?: string;
  /** Reasoning effort for backends that take one (grok: low | medium | high | xhigh). */
  reasoningEffort?: string;
  /** grok: a token file kept fresh by someone else (the deploy's refresh timer); read on every call, the CLI is never run. */
  authFile?: string;
}

export class BrainError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BrainError";
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/** Build the probe's profile from one timed request and whatever the server reported about itself. */
export function profileFrom(r: DecisionResult, server: Partial<Pick<BackendProfile, "slots" | "ctxPerSlot" | "modelFile" | "quant">> = {}, now = Date.now()): BackendProfile {
  const t = r.timings;
  const prefillTps = t && t.promptMs > 0 ? ((t.promptTokens - t.cachedTokens) * 1000) / t.promptMs : 0;
  const decodeTps = t && t.outputMs > 0 ? (t.outputTokens * 1000) / t.outputMs : r.tokensPerSec;
  return { kind: classifyBackend(prefillTps, decodeTps), prefillTps: Math.round(prefillTps * 10) / 10, decodeTps: Math.round(decodeTps * 10) / 10, cacheable: !!t, probedAt: now, ...server };
}
