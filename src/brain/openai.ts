/**
 * OpenAI-compatible chat completions. This one backend covers llama.cpp's
 * llama-server (`/v1`), Ollama (`/v1`), LM Studio, vLLM, text-generation-
 * webui, and anything else that speaks the same dialect.
 */
import { getJson, joinUrl, postJson, readSse } from "./http";
import { BrainError, PROBE_PROMPT, estimateTokens, profileFrom, type BackendProfile, type BackendTimings, type Brain, type BrainConfig, type DecideOptions, type DecisionRequest, type DecisionResult, type FetchLike } from "./types";

interface ChatChunk {
  choices?: { delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { completion_tokens?: number; prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  /** llama-server extension: where the time went. */
  timings?: { cache_n?: number; prompt_n?: number; prompt_ms?: number; predicted_n?: number; predicted_ms?: number };
}

/** llama-server `/props`, the part that describes the server. */
interface ServerProps {
  total_slots?: number;
  model_path?: string;
  model_ftype?: string;
  default_generation_settings?: { n_ctx?: number };
}

/** Read llama-server's timings out of a chunk, when it carries them. */
export function timingsFrom(chunk: ChatChunk): BackendTimings | undefined {
  const t = chunk.timings;
  if (!t || typeof t.predicted_n !== "number" || typeof t.predicted_ms !== "number") return undefined;
  const cached = chunk.usage?.prompt_tokens_details?.cached_tokens ?? t.cache_n ?? 0;
  return { promptTokens: chunk.usage?.prompt_tokens ?? (t.prompt_n ?? 0) + cached, cachedTokens: cached, promptMs: t.prompt_ms ?? 0, outputTokens: t.predicted_n, outputMs: t.predicted_ms };
}

/** Sampling fields as the llama-server / vLLM dialect names them, only those that were set. */
function sampling(src: { topP?: number; minP?: number; repeatPenalty?: number }): { top_p?: number; min_p?: number; repeat_penalty?: number } {
  return { ...(src.topP !== undefined ? { top_p: src.topP } : {}), ...(src.minP !== undefined ? { min_p: src.minP } : {}), ...(src.repeatPenalty !== undefined ? { repeat_penalty: src.repeatPenalty } : {}) };
}

export class OpenAICompatibleBrain implements Brain {
  readonly kind = "openai";
  readonly baseUrl: string;
  model: string;
  private readonly fetchImpl: FetchLike;
  private readonly apiKey?: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly sampling: { top_p?: number; min_p?: number; repeat_penalty?: number };
  private readonly stream: boolean;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(cfg: BrainConfig) {
    this.baseUrl = (cfg.baseUrl ?? "http://127.0.0.1:8080/v1").replace(/\/+$/, "");
    this.model = cfg.model ?? "";
    this.fetchImpl = cfg.fetch ?? fetch;
    this.apiKey = cfg.apiKey;
    this.maxTokens = cfg.maxTokens ?? 400;
    this.temperature = cfg.temperature ?? 0.7;
    this.sampling = sampling(cfg);
    this.stream = cfg.stream ?? true;
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.headers = { ...(cfg.headers ?? {}) };
    if (this.apiKey) this.headers.authorization = `Bearer ${this.apiKey}`;
  }

  /** The server root for llama-server's own endpoints (`/props`), beside the `/v1` dialect. */
  private rootUrl(): string {
    return this.baseUrl.replace(/\/v1$/, "");
  }

  private http(signal?: AbortSignal) {
    return { fetch: this.fetchImpl, timeoutMs: this.timeoutMs, headers: this.headers, signal };
  }

  async decide(req: DecisionRequest, opts: DecideOptions = {}): Promise<DecisionResult> {
    const t0 = performance.now();
    const body = {
      model: this.model || undefined,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxTokens ?? this.maxTokens,
      temperature: req.temperature ?? this.temperature,
      ...this.sampling,
      ...sampling(req),
      ...(req.stop?.length ? { stop: req.stop } : {}),
      stream: this.stream,
      // llama-server: reuse the slot's KV cache for the common prefix, and keep one node in one slot.
      cache_prompt: !req.noCache,
      ...(req.slot !== undefined ? { id_slot: req.slot } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(this.stream ? { stream_options: { include_usage: true } } : {}),
    };
    const res = await postJson(joinUrl(this.baseUrl, "chat/completions"), body, this.http(opts.signal));
    let text = "";
    let tokens: number | undefined;
    let truncated = false;
    let timings: BackendTimings | undefined;
    if (this.stream) {
      for await (const raw of readSse(res.body)) {
        const chunk = raw as ChatChunk;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          opts.onToken?.(delta);
        }
        if (choice?.finish_reason === "length") truncated = true;
        if (typeof chunk.usage?.completion_tokens === "number") tokens = chunk.usage.completion_tokens;
        timings = timingsFrom(chunk) ?? timings;
      }
    } else {
      const json = (await res.json()) as ChatChunk;
      text = json.choices?.[0]?.message?.content ?? "";
      truncated = json.choices?.[0]?.finish_reason === "length";
      if (typeof json.usage?.completion_tokens === "number") tokens = json.usage.completion_tokens;
      timings = timingsFrom(json);
      if (text) opts.onToken?.(text);
    }
    const latencyMs = performance.now() - t0;
    const estimated = tokens === undefined;
    const n = tokens ?? estimateTokens(text);
    // Generation speed is decode only when the server says where the time went; otherwise output over the whole turn.
    const tokensPerSec = timings && timings.outputMs > 0 ? (timings.outputTokens * 1000) / timings.outputMs : latencyMs > 0 ? (n * 1000) / latencyMs : 0;
    return { text, latencyMs, tokens: n, tokensPerSec, estimated, truncated, timings };
  }

  async probe(): Promise<BackendProfile | undefined> {
    try {
      let server: Partial<BackendProfile> = {};
      try {
        const p = (await getJson(joinUrl(this.rootUrl(), "props"), { ...this.http(), timeoutMs: 5000 })) as ServerProps;
        server = { slots: p.total_slots, ctxPerSlot: p.default_generation_settings?.n_ctx, modelFile: p.model_path?.split("/").pop(), quant: p.model_ftype };
      } catch {
        // not llama-server: only the timed request tells us anything
      }
      const r = await this.decide({ system: "", user: PROBE_PROMPT, maxTokens: 16, temperature: 0, noCache: true });
      return profileFrom(r, server);
    } catch {
      return undefined;
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string; models?: string[] }> {
    try {
      const json = (await getJson(joinUrl(this.baseUrl, "models"), { ...this.http(), timeoutMs: Math.min(this.timeoutMs, 5000) })) as { data?: { id?: string }[] };
      const models = (json.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
      if (!this.model && models[0]) this.model = models[0];
      return { ok: true, detail: `${models.length} model(s)`, models };
    } catch (e) {
      return { ok: false, detail: e instanceof BrainError ? e.message : String(e) };
    }
  }
}
