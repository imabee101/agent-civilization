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
  /** Optional structured hints for non-model brains (e.g. random) that can't read the prompt. */
  context?: {
    visibleNodeIds?: string[];
  };
}

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
}

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
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BrainConfig {
  /** Registered backend kind: "openai" | "llamacpp" | "ollama" | "random" | custom. */
  kind: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
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
