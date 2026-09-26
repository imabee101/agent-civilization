/**
 * llama.cpp `llama-server` native API (`POST /completion`). Use this when you
 * want llama.cpp-specific knobs (raw prompt, timings) rather than the
 * OpenAI-compatible `/v1` route, which the `openai` backend also covers.
 */
import { getJson, joinUrl, postJson, readSse } from "./http";
import { BrainError, PROBE_PROMPT, estimateTokens, profileFrom, type BackendProfile, type BackendTimings, type Brain, type BrainConfig, type DecideOptions, type DecisionRequest, type DecisionResult, type FetchLike } from "./types";

interface CompletionChunk {
  content?: string;
  stop?: boolean;
  stop_type?: string;
  timings?: { cache_n?: number; prompt_n?: number; prompt_ms?: number; predicted_n?: number; predicted_ms?: number; predicted_per_second?: number };
  tokens_predicted?: number;
  tokens_cached?: number;
  truncated?: boolean;
}

export type PromptFormat = NonNullable<BrainConfig["promptFormat"]>;

/** Turn system+user into raw text for a completion endpoint. */
export function formatPrompt(format: PromptFormat, system: string, user: string): string {
  switch (format) {
    case "chatml":
      return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`;
    case "llama3":
      return `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n${system}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n${user}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`;
    case "plain":
      return `${system}\n\n${user}\n\nResponse:\n`;
  }
}

const STOP_STRINGS: Record<PromptFormat, string[]> = {
  chatml: ["<|im_end|>", "<|im_start|>"],
  llama3: ["<|eot_id|>", "<|start_header_id|>"],
  plain: ["\n\nResponse:"],
};

export class LlamaCppBrain implements Brain {
  readonly kind = "llamacpp";
  readonly baseUrl: string;
  model: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly sampling: { top_p?: number; min_p?: number; repeat_penalty?: number };
  private readonly stream: boolean;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly format: PromptFormat;

  constructor(cfg: BrainConfig) {
    this.baseUrl = (cfg.baseUrl ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
    this.model = cfg.model ?? "llama.cpp";
    this.fetchImpl = cfg.fetch ?? fetch;
    this.maxTokens = cfg.maxTokens ?? 400;
    this.temperature = cfg.temperature ?? 0.7;
    this.sampling = { ...(cfg.topP !== undefined ? { top_p: cfg.topP } : {}), ...(cfg.minP !== undefined ? { min_p: cfg.minP } : {}), ...(cfg.repeatPenalty !== undefined ? { repeat_penalty: cfg.repeatPenalty } : {}) };
    this.stream = cfg.stream ?? true;
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.headers = { ...(cfg.headers ?? {}) };
    if (cfg.apiKey) this.headers.authorization = `Bearer ${cfg.apiKey}`;
    this.format = cfg.promptFormat ?? "chatml";
  }

  private http(signal?: AbortSignal) {
    return { fetch: this.fetchImpl, timeoutMs: this.timeoutMs, headers: this.headers, signal };
  }

  async decide(req: DecisionRequest, opts: DecideOptions = {}): Promise<DecisionResult> {
    const t0 = performance.now();
    const body = {
      prompt: formatPrompt(this.format, req.system, req.user),
      n_predict: req.maxTokens ?? this.maxTokens,
      temperature: req.temperature ?? this.temperature,
      ...this.sampling,
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      ...(req.minP !== undefined ? { min_p: req.minP } : {}),
      ...(req.repeatPenalty !== undefined ? { repeat_penalty: req.repeatPenalty } : {}),
      stream: this.stream,
      cache_prompt: !req.noCache,
      ...(req.slot !== undefined ? { id_slot: req.slot } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      stop: [...STOP_STRINGS[this.format], ...(req.stop ?? [])],
    };
    const res = await postJson(joinUrl(this.baseUrl, "completion"), body, this.http(opts.signal));
    let text = "";
    let tokens: number | undefined;
    let reportedTps: number | undefined;
    let timings: BackendTimings | undefined;
    let truncated = false;
    const absorb = (c: CompletionChunk) => {
      if (typeof c.timings?.predicted_n === "number") tokens = c.timings.predicted_n;
      else if (typeof c.tokens_predicted === "number") tokens = c.tokens_predicted;
      if (typeof c.timings?.predicted_per_second === "number") reportedTps = c.timings.predicted_per_second;
      const t = c.timings;
      if (t && typeof t.predicted_n === "number" && typeof t.predicted_ms === "number") {
        const cached = t.cache_n ?? c.tokens_cached ?? 0;
        timings = { promptTokens: (t.prompt_n ?? 0) + cached, cachedTokens: cached, promptMs: t.prompt_ms ?? 0, outputTokens: t.predicted_n, outputMs: t.predicted_ms };
      }
      if (c.stop_type === "limit" || c.truncated) truncated = true;
    };
    if (this.stream) {
      for await (const raw of readSse(res.body)) {
        const c = raw as CompletionChunk;
        if (c.content) {
          text += c.content;
          opts.onToken?.(c.content);
        }
        absorb(c);
        if (c.stop) break;
      }
    } else {
      const c = (await res.json()) as CompletionChunk;
      text = c.content ?? "";
      absorb(c);
      if (text) opts.onToken?.(text);
    }
    const latencyMs = performance.now() - t0;
    const estimated = tokens === undefined;
    const n = tokens ?? estimateTokens(text);
    return { text, latencyMs, tokens: n, tokensPerSec: reportedTps ?? (latencyMs > 0 ? (n * 1000) / latencyMs : 0), estimated, truncated, timings };
  }

  async probe(): Promise<BackendProfile | undefined> {
    try {
      let server: Partial<BackendProfile> = {};
      try {
        const p = (await getJson(joinUrl(this.baseUrl, "props"), { ...this.http(), timeoutMs: 5000 })) as { total_slots?: number; model_path?: string; model_ftype?: string; default_generation_settings?: { n_ctx?: number } };
        server = { slots: p.total_slots, ctxPerSlot: p.default_generation_settings?.n_ctx, modelFile: p.model_path?.split("/").pop(), quant: p.model_ftype };
      } catch {
        // /props is optional
      }
      const r = await this.decide({ system: "", user: PROBE_PROMPT, maxTokens: 16, temperature: 0, noCache: true });
      return profileFrom(r, server);
    } catch {
      return undefined;
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string; models?: string[] }> {
    try {
      const h = (await getJson(joinUrl(this.baseUrl, "health"), { ...this.http(), timeoutMs: 5000 })) as { status?: string };
      if (h.status && h.status !== "ok") return { ok: false, detail: `status ${h.status}` };
      try {
        const props = (await getJson(joinUrl(this.baseUrl, "props"), { ...this.http(), timeoutMs: 5000 })) as { model_path?: string; default_generation_settings?: { model?: string } };
        const name = props.default_generation_settings?.model ?? props.model_path;
        if (name && (this.model === "llama.cpp" || !this.model)) this.model = name.split("/").pop() ?? name;
      } catch {
        // /props is optional
      }
      return { ok: true, detail: "ok", models: [this.model] };
    } catch (e) {
      return { ok: false, detail: e instanceof BrainError ? e.message : String(e) };
    }
  }
}
