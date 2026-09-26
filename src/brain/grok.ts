/**
 * The local Grok CLI (`grok -p`, headless), signed in as whoever runs the game.
 * Each turn is one single-turn session: our system prompt replaces Grok's, its
 * tools, subagents, memory and web search are off, and its streamed Messages-API
 * events are read for text. No API key passes through here; the CLI holds its own login.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNdjson } from "./http";
import { BrainError, PROBE_PROMPT, estimateTokens, type BackendProfile, type Brain, type BrainConfig, type DecideOptions, type DecisionRequest, type DecisionResult } from "./types";

/** What the brain needs from a child process; Bun.spawn in production, a fake in tests. */
export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}
export type Spawner = (argv: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => SpawnedProcess;

const bunSpawn: Spawner = (argv, opts) => {
  const p = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return { stdout: p.stdout, exited: p.exited, kill: () => p.kill() };
};

interface GrokLine {
  type?: string;
  event?: { type?: string; delta?: { type?: string; text?: string; stop_reason?: string } };
  result?: string;
  is_error?: boolean;
  subtype?: string;
  errors?: string[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  total_cost_usd?: number;
}

export class GrokBrain implements Brain {
  readonly kind = "grok";
  readonly model: string;
  /** Dollars the CLI reported for every turn so far; the CLI's own figure, not a bill. */
  costUsd = 0;
  private readonly command: string;
  private readonly effort: string;
  private readonly timeoutMs: number;
  private readonly spawn: Spawner;
  private cwd?: string;

  constructor(cfg: BrainConfig & { spawn?: Spawner }) {
    this.model = cfg.model ?? "grok-4.7-build-fast";
    this.command = cfg.command ?? "grok";
    this.effort = cfg.reasoningEffort ?? "low";
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.spawn = cfg.spawn ?? bunSpawn;
  }

  /** An empty directory, so no project's AGENTS.md or rules reach the prompt. */
  private workdir(): string {
    this.cwd ??= mkdtempSync(join(tmpdir(), "agentciv-grok-"));
    return this.cwd;
  }

  argv(req: DecisionRequest): string[] {
    return [
      this.command,
      "-p", req.user,
      "--system-prompt-override", req.system || "Reply briefly.",
      "--verbatim",
      "-m", this.model,
      "--reasoning-effort", this.effort,
      "--max-turns", "1",
      "--no-subagents",
      "--no-plan",
      "--disable-web-search",
      // An empty --tools list is ignored: allow one tool, then deny it and the CLI's two built-ins, which leaves none.
      // A tool call would end the single turn with no text.
      "--tools", "read_file",
      "--disallowed-tools", "read_file,search_tool,use_tool",
      "--output-format", "streaming-messages-json",
      "--include-partial-messages",
    ];
  }

  async decide(req: DecisionRequest, opts: DecideOptions = {}): Promise<DecisionResult> {
    const t0 = performance.now();
    const env = { ...process.env, GROK_MEMORY: "0", GROK_WORKFLOWS: "0", GROK_SUBAGENTS: "0" };
    const proc = this.spawn(this.argv(req), { cwd: this.workdir(), env });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, this.timeoutMs);
    const onAbort = () => proc.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let streamed = "";
    let final: GrokLine | undefined;
    try {
      for await (const raw of readNdjson(proc.stdout)) {
        const l = raw as GrokLine;
        const d = l.event?.delta;
        if (l.type === "stream_event" && l.event?.type === "content_block_delta" && d?.type === "text_delta" && d.text) {
          streamed += d.text;
          opts.onToken?.(d.text);
        } else if (l.type === "result") final = l;
      }
      const code = await proc.exited;
      if (timedOut) throw new BrainError(`grok: no reply within ${this.timeoutMs} ms`);
      if (opts.signal?.aborted) throw new BrainError("grok: aborted");
      if (!final) throw new BrainError(`grok: exited ${code} without a result (signed in? try \`grok models\`)`);
      if (final.is_error) throw new BrainError(`grok: ${final.errors?.join("; ") || final.result || final.subtype || "error"}`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    const text = final.result ?? streamed;
    if (!text.trim()) throw new BrainError("grok: empty reply");
    if (!streamed) opts.onToken?.(text);
    this.costUsd += final.total_cost_usd ?? 0;
    const latencyMs = performance.now() - t0;
    const reported = final.usage?.output_tokens;
    const tokens = reported ?? estimateTokens(text);
    return { text, latencyMs, tokens, tokensPerSec: latencyMs > 0 ? (tokens * 1000) / latencyMs : 0, estimated: reported === undefined, truncated: final.stop_reason === "max_tokens" };
  }

  /**
   * A hosted model does not share this machine's memory bus, so parallel turns do not slow each
   * other the way they do on a local CPU: it is classed fast. The rates are whole-request lower bounds.
   */
  async probe(): Promise<BackendProfile | undefined> {
    try {
      const r = await this.decide({ system: "", user: PROBE_PROMPT });
      const secs = r.latencyMs / 1000;
      return { kind: "fast", prefillTps: Math.round(estimateTokens(PROBE_PROMPT) / secs), decodeTps: Math.round((r.tokens / secs) * 10) / 10, cacheable: false, probedAt: Date.now() };
    } catch {
      return undefined;
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string; models?: string[] }> {
    try {
      const p = Bun.spawn([this.command, "models"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0 || !/logged in/i.test(out)) return { ok: false, detail: "grok CLI not signed in (run `grok login`)" };
      const models = [...out.matchAll(/^\s*[*-]\s+(\S+)/gm)].map((m) => m[1]!);
      return { ok: models.length === 0 || models.includes(this.model), detail: models.includes(this.model) ? `signed in, ${this.model}` : `signed in; no model ${this.model}`, models };
    } catch (e) {
      return { ok: false, detail: `grok CLI not runnable: ${String(e)}` };
    }
  }
}
