import type { Brain, DecideOptions, DecisionRequest, DecisionResult } from "../../src/brain/types";

/** A brain that replays scripted outputs (or errors) in order, optionally slowly. */
export class ScriptedBrain implements Brain {
  readonly kind = "scripted";
  readonly model = "test";
  readonly requests: DecisionRequest[] = [];
  healthy = true;
  constructor(
    private outputs: (string | Error)[] = [],
    private delayMs = 0,
  ) {}
  push(...o: (string | Error)[]) {
    this.outputs.push(...o);
  }
  async decide(req: DecisionRequest, opts: DecideOptions = {}): Promise<DecisionResult> {
    this.requests.push(req);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const next = this.outputs.shift() ?? "```js\nrest()\n```";
    if (next instanceof Error) throw next;
    // stream in two pieces so onToken gets exercised
    const mid = Math.floor(next.length / 2);
    opts.onToken?.(next.slice(0, mid));
    opts.onToken?.(next.slice(mid));
    return { text: next, latencyMs: this.delayMs, tokens: 3, tokensPerSec: 30, estimated: false };
  }
  async health() {
    return { ok: this.healthy, detail: this.healthy ? "scripted" : "down" };
  }
}

export const js = (code: string) => "```js\n" + code + "\n```";
