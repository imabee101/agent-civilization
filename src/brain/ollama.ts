/** Ollama native API (`POST /api/chat`, newline-delimited JSON streaming). */
import { getJson, joinUrl, postJson, readNdjson } from "./http";
import { BrainError, PROBE_PROMPT, estimateTokens, profileFrom, type BackendProfile, type BackendTimings, type Brain, type BrainConfig, type DecideOptions, type DecisionRequest, type DecisionResult, type FetchLike } from "./types";

interface OllamaChunk {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
}

export class OllamaBrain implements Brain {
  readonly kind = "ollama";
  readonly baseUrl: string;
  model: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly sampling: { top_p?: number; min_p?: number; repeat_penalty?: number };
  private readonly stream: boolean;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(cfg: BrainConfig) {
    this.baseUrl = (cfg.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.model = cfg.model ?? "";
    this.fetchImpl = cfg.fetch ?? fetch;
    this.maxTokens = cfg.maxTokens ?? 400;
    this.temperature = cfg.temperature ?? 0.7;
    this.sampling = { ...(cfg.topP !== undefined ? { top_p: cfg.topP } : {}), ...(cfg.minP !== undefined ? { min_p: cfg.minP } : {}), ...(cfg.repeatPenalty !== undefined ? { repeat_penalty: cfg.repeatPenalty } : {}) };
    this.stream = cfg.stream ?? true;
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.headers = { ...(cfg.headers ?? {}) };
  }

  private http(signal?: AbortSignal) {
    return { fetch: this.fetchImpl, timeoutMs: this.timeoutMs, headers: this.headers, signal };
  }

  async decide(req: DecisionRequest, opts: DecideOptions = {}): Promise<DecisionResult> {
    if (!this.model) throw new BrainError("ollama: no model configured (set AGENTCIV_MODEL or pull one)");
    const t0 = performance.now();
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      stream: this.stream,
      options: {
        temperature: req.temperature ?? this.temperature,
        num_predict: req.maxTokens ?? this.maxTokens,
        ...this.sampling,
        ...(req.topP !== undefined ? { top_p: req.topP } : {}),
        ...(req.minP !== undefined ? { min_p: req.minP } : {}),
        ...(req.repeatPenalty !== undefined ? { repeat_penalty: req.repeatPenalty } : {}),
        ...(req.stop?.length ? { stop: req.stop } : {}),
      },
    };
    const res = await postJson(joinUrl(this.baseUrl, "api/chat"), body, this.http(opts.signal));
    let text = "";
    let tokens: number | undefined;
    let evalNs: number | undefined;
    let timings: BackendTimings | undefined;
    let truncated = false;
    const absorb = (c: OllamaChunk) => {
      if (typeof c.eval_count === "number") tokens = c.eval_count;
      if (typeof c.eval_duration === "number") evalNs = c.eval_duration;
      if (typeof c.eval_count === "number" && typeof c.eval_duration === "number") {
        timings = { promptTokens: c.prompt_eval_count ?? 0, cachedTokens: 0, promptMs: (c.prompt_eval_duration ?? 0) / 1e6, outputTokens: c.eval_count, outputMs: c.eval_duration / 1e6 };
      }
      if (c.done_reason === "length") truncated = true;
    };
    if (this.stream) {
      for await (const raw of readNdjson(res.body)) {
        const c = raw as OllamaChunk;
        const piece = c.message?.content;
        if (piece) {
          text += piece;
          opts.onToken?.(piece);
        }
        absorb(c);
        if (c.done) break;
      }
    } else {
      const c = (await res.json()) as OllamaChunk;
      text = c.message?.content ?? "";
      absorb(c);
      if (text) opts.onToken?.(text);
    }
    const latencyMs = performance.now() - t0;
    const estimated = tokens === undefined;
    const n = tokens ?? estimateTokens(text);
    const tps = evalNs && evalNs > 0 && tokens !== undefined ? (tokens * 1e9) / evalNs : latencyMs > 0 ? (n * 1000) / latencyMs : 0;
    return { text, latencyMs, tokens: n, tokensPerSec: tps, estimated, truncated, timings };
  }

  async probe(): Promise<BackendProfile | undefined> {
    try {
      const r = await this.decide({ system: "", user: PROBE_PROMPT, maxTokens: 16, temperature: 0, noCache: true });
      return profileFrom(r);
    } catch {
      return undefined;
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string; models?: string[] }> {
    try {
      const json = (await getJson(joinUrl(this.baseUrl, "api/tags"), { ...this.http(), timeoutMs: 5000 })) as { models?: { name?: string }[] };
      const models = (json.models ?? []).map((m) => m.name).filter((x): x is string => typeof x === "string");
      if (!this.model && models[0]) this.model = models[0];
      return { ok: models.length > 0 || !!this.model, detail: models.length ? `${models.length} model(s)` : "no models pulled", models };
    } catch (e) {
      return { ok: false, detail: e instanceof BrainError ? e.message : String(e) };
    }
  }
}
