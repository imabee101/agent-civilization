/**
 * OpenAI-compatible chat completions. This one backend covers llama.cpp's
 * llama-server (`/v1`), Ollama (`/v1`), LM Studio, vLLM, text-generation-
 * webui, and anything else that speaks the same dialect.
 */
import { getJson, joinUrl, postJson, readSse } from "./http";
import { BrainError, estimateTokens, type Brain, type BrainConfig, type DecideOptions, type DecisionRequest, type DecisionResult, type FetchLike } from "./types";

interface ChatChunk {
  choices?: { delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { completion_tokens?: number } | null;
}

export class OpenAICompatibleBrain implements Brain {
  readonly kind = "openai";
  readonly baseUrl: string;
  model: string;
  private readonly fetchImpl: FetchLike;
  private readonly apiKey?: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
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
    this.stream = cfg.stream ?? true;
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.headers = { ...(cfg.headers ?? {}) };
    if (this.apiKey) this.headers.authorization = `Bearer ${this.apiKey}`;
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
      stream: this.stream,
      ...(this.stream ? { stream_options: { include_usage: true } } : {}),
    };
    const res = await postJson(joinUrl(this.baseUrl, "chat/completions"), body, this.http(opts.signal));
    let text = "";
    let tokens: number | undefined;
    if (this.stream) {
      for await (const raw of readSse(res.body)) {
        const chunk = raw as ChatChunk;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          opts.onToken?.(delta);
        }
        if (typeof chunk.usage?.completion_tokens === "number") tokens = chunk.usage.completion_tokens;
      }
    } else {
      const json = (await res.json()) as ChatChunk;
      text = json.choices?.[0]?.message?.content ?? "";
      if (typeof json.usage?.completion_tokens === "number") tokens = json.usage.completion_tokens;
      if (text) opts.onToken?.(text);
    }
    const latencyMs = performance.now() - t0;
    const estimated = tokens === undefined;
    const n = tokens ?? estimateTokens(text);
    return { text, latencyMs, tokens: n, tokensPerSec: latencyMs > 0 ? (n * 1000) / latencyMs : 0, estimated };
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
