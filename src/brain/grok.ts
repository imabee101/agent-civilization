/**
 * Grok through the sign-in of the local Grok CLI: the Responses API endpoint the CLI itself
 * talks to, called directly with the OAuth token the CLI keeps in ~/.grok/auth.json.
 *
 * Going direct rather than through `grok -p` sends one request per turn instead of three
 * (the CLI adds a session-title and a turn-summary call) and none of the CLI's own rules,
 * and it keeps a node's turns under one prompt_cache_key, so the system prompt and the
 * node's files are served from cache on its next turn. The CLI is only run to refresh the
 * token. The token is read at call time and never logged.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { postJson, readSse } from "./http";
import { BrainError, PROBE_PROMPT, estimateTokens, type BackendProfile, type BackendTimings, type Brain, type BrainConfig, type DecideOptions, type DecisionRequest, type DecisionResult, type FetchLike } from "./types";

export interface GrokAuth {
  token: string;
  /** Epoch ms; NaN when the file does not say. */
  expiresAt: number;
}
/** Where the token comes from; the CLI's auth file in production, a stub in tests. */
export type AuthSource = () => Promise<GrokAuth | undefined>;
/** Asks the CLI for a fresh token; resolves when it has written one. */
export type Refresher = () => Promise<void>;

export const GROK_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
/** A token closer than this to expiry is refreshed before use. */
const REFRESH_MARGIN_MS = 30 * 60_000;
/** The CLI version whose headers these are; the endpoint serves CLI clients. */
const CLIENT_VERSION = "1.0.40";

export function authFromFile(path = join(homedir(), ".grok", "auth.json")): AuthSource {
  return async () => {
    try {
      const json = (await Bun.file(path).json()) as Record<string, { key?: unknown; expires_at?: unknown }>;
      const entry = Object.values(json).find((v) => v && typeof v.key === "string" && v.key.length > 0);
      if (!entry) return undefined;
      return { token: entry.key as string, expiresAt: typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : NaN };
    } catch {
      return undefined;
    }
  };
}

/** `grok models` with early invalidation set makes the CLI trade its refresh token for a new access token. */
export function cliRefresher(command = "grok"): Refresher {
  return async () => {
    const p = Bun.spawn([command, "models"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, GROK_AUTH_EARLY_INVALIDATION_SECS: "3600" } });
    await p.exited;
  };
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  message?: string;
  response?: {
    status?: string;
    incomplete_details?: { reason?: string };
    error?: { message?: string };
    usage?: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens?: number; cost_in_usd_ticks?: number };
  };
}

export class GrokBrain implements Brain {
  readonly kind = "grok";
  readonly model: string;
  readonly baseUrl: string;
  /** Dollars the endpoint reported for every turn so far. */
  costUsd = 0;
  private readonly effort: string;
  private readonly temperature?: number;
  private readonly topP?: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly auth: AuthSource;
  private readonly refresher: Refresher;
  private refreshing?: Promise<void>;
  private readonly authPath: string;

  constructor(cfg: BrainConfig & { auth?: AuthSource; refresh?: Refresher }) {
    this.model = cfg.model ?? "grok-4.7";
    this.baseUrl = (cfg.baseUrl ?? GROK_BASE_URL).replace(/\/+$/, "");
    this.effort = cfg.reasoningEffort ?? "minimal";
    this.temperature = cfg.temperature;
    this.topP = cfg.topP;
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.fetchImpl = cfg.fetch ?? fetch;
    this.authPath = cfg.authFile ?? "~/.grok/auth.json";
    this.auth = cfg.auth ?? authFromFile(cfg.authFile);
    // A given token file is kept fresh by whoever wrote it: refreshing is reading it again.
    this.refresher = cfg.refresh ?? (cfg.authFile ? async () => {} : cliRefresher(cfg.command));
  }

  /** One refresh at a time, however many turns asked for it. */
  private refresh(): Promise<void> {
    this.refreshing ??= this.refresher().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async token(force = false): Promise<string> {
    let a = await this.auth();
    if (force || !a || a.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      await this.refresh();
      a = await this.auth();
    }
    if (!a) throw new BrainError(`grok: no token in ${this.authPath} (run \`grok login\`, or the deploy's token timer)`);
    return a.token;
  }

  private headers(token: string, convId?: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: "text/event-stream",
      "user-agent": `grok-shell/${CLIENT_VERSION} (linux; x86_64)`,
      "x-grok-client-identifier": "grok-shell",
      "x-grok-client-mode": "headless",
      "x-grok-client-version": CLIENT_VERSION,
      "x-xai-token-auth": "xai-grok-cli",
      "x-authenticateresponse": "authenticate-response",
      "x-grok-model-override": this.model,
      ...(convId ? { "x-grok-conv-id": convId } : {}),
    };
  }

  body(req: DecisionRequest): Record<string, unknown> {
    const temperature = req.temperature ?? this.temperature;
    const topP = req.topP ?? this.topP;
    return {
      model: this.model,
      stream: true,
      store: false,
      reasoning: { effort: this.effort },
      ...(req.cacheKey && !req.noCache ? { prompt_cache_key: `agentciv-${req.cacheKey}` } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
      input: [...(req.system ? [{ type: "message", role: "system", content: req.system }] : []), { type: "message", role: "user", content: req.user }],
    };
  }

  async decide(req: DecisionRequest, opts: DecideOptions = {}): Promise<DecisionResult> {
    const t0 = performance.now();
    const ctl = new AbortController();
    const onOuterAbort = () => ctl.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const url = `${this.baseUrl}/responses`;
    const convId = req.cacheKey && !req.noCache ? `agentciv-${req.cacheKey}` : undefined;
    const http = (token: string) => ({ fetch: this.fetchImpl, timeoutMs: this.timeoutMs, headers: this.headers(token, convId), signal: ctl.signal });
    let text = "";
    let shown = 0;
    let stopped = false;
    let done: ResponsesEvent["response"];
    try {
      let res: Response;
      try {
        res = await postJson(url, this.body(req), http(await this.token()));
      } catch (e) {
        if (!(e instanceof BrainError) || (e.status !== 401 && e.status !== 403)) throw e;
        res = await postJson(url, this.body(req), http(await this.token(true)));
      }
      for await (const raw of readSse(res.body)) {
        const ev = raw as ResponsesEvent;
        if (ev.type === "response.output_text.delta" && ev.delta) {
          // The endpoint takes no stop strings: cut where one appears, and read on only for the usage that closes the stream.
          if (stopped) continue;
          const stops = req.stop ?? [];
          const before = text.length;
          text += ev.delta;
          const at = Math.min(...stops.map((s) => text.indexOf(s, Math.max(0, before - s.length + 1))).filter((i) => i >= 0));
          if (Number.isFinite(at)) {
            text = text.slice(0, at);
            stopped = true;
          }
          // Hold back a tail that could still grow into a stop string; it is shown once the next delta rules that out.
          const held = stopped ? 0 : Math.max(0, ...stops.flatMap((s) => [...Array(s.length).keys()].filter((k) => k > 0 && text.endsWith(s.slice(0, k)))));
          const upTo = text.length - held;
          if (upTo > shown) opts.onToken?.(text.slice(shown, upTo));
          shown = Math.max(shown, upTo);
        } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
          done = ev.response;
        } else if (ev.type === "response.failed" || ev.type === "error") {
          throw new BrainError(`grok: ${ev.response?.error?.message ?? ev.message ?? "request failed"}`);
        }
      }
    } finally {
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
    if (opts.signal?.aborted) throw new BrainError("grok: aborted");
    if (text.length > shown) opts.onToken?.(text.slice(shown));
    if (!done) throw new BrainError("grok: stream ended without a response");
    if (!text.trim()) throw new BrainError("grok: empty reply");
    const u = done?.usage;
    // cost_in_usd_ticks: 1e10 ticks to the dollar.
    this.costUsd += (u?.cost_in_usd_ticks ?? 0) / 1e10;
    const latencyMs = performance.now() - t0;
    const tokens = u?.output_tokens ?? estimateTokens(text);
    // Token counts only: the endpoint reports no prefill or decode time, and a guess would misclassify the backend.
    const timings: BackendTimings | undefined = u?.input_tokens ? { promptTokens: u.input_tokens, cachedTokens: u.input_tokens_details?.cached_tokens ?? 0, promptMs: 0, outputTokens: tokens, outputMs: 0 } : undefined;
    return { text, latencyMs, tokens, tokensPerSec: latencyMs > 0 ? (tokens * 1000) / latencyMs : 0, estimated: u?.output_tokens === undefined, truncated: done?.status === "incomplete" && done.incomplete_details?.reason === "max_output_tokens", timings };
  }

  /**
   * A hosted model does not share this machine's memory bus, so parallel turns do not slow each
   * other the way they do on a local CPU: it is classed fast. The rates are whole-request lower bounds.
   */
  async probe(): Promise<BackendProfile | undefined> {
    try {
      const r = await this.decide({ system: "", user: PROBE_PROMPT, noCache: true });
      const secs = r.latencyMs / 1000;
      return { kind: "fast", prefillTps: Math.round(estimateTokens(PROBE_PROMPT) / secs), decodeTps: Math.round((r.tokens / secs) * 10) / 10, cacheable: true, probedAt: Date.now() };
    } catch {
      return undefined;
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string; models?: string[] }> {
    try {
      await this.token();
      return { ok: true, detail: `signed in, ${this.model}` };
    } catch (e) {
      return { ok: false, detail: e instanceof BrainError ? e.message : String(e) };
    }
  }
}
