/**
 * The no-model baseline. It picks one valid primitive call uniformly at
 * random. It is deliberately dumb: no weights, no heuristics, no notion of
 * what would be "interesting". Its only job is to be a control group and to
 * keep the world moving when no model is configured.
 */
import { Rng } from "../world/rng";
import type { Brain, BrainConfig, DecideOptions, DecisionRequest, DecisionResult } from "./types";

const WORDS = ["hello", "food", "here", "north", "help", "mine", "yours", "come", "go", "why", "yes", "no", "trade", "look", "night", "day"];

type Snippet = (rng: Rng, ctx: DecisionRequest["context"]) => string | null;

/** Each entry is one uniformly-weighted option. Entries that need a visible node return null when there is none. */
export const RANDOM_SNIPPETS: readonly Snippet[] = [
  (rng) => `move(${rng.int(6)})`,
  () => `gather()`,
  (rng) => `gather(${JSON.stringify(rng.pick(["wood", "stone"]))})`,
  (rng) => `eat(${5 + rng.int(20)})`,
  () => `rest()`,
  (rng) => `say(${JSON.stringify(rng.pick(WORDS) + " " + rng.pick(WORDS))})`,
  (rng) => `drop(${1 + rng.int(5)})`,
  (rng) => `me.set("status", ${JSON.stringify(rng.pick(WORDS))})`,
  (rng, ctx) => {
    const ids = ctx?.visibleNodeIds ?? [];
    return ids.length ? `send(${JSON.stringify(rng.pick(ids))}, ${JSON.stringify({ word: rng.pick(WORDS) })})` : null;
  },
  (rng) => `fs.write("note.txt", ${JSON.stringify(rng.pick(WORDS))})`,
  () => `log(JSON.stringify(observe().me))`,
];

export class RandomBrain implements Brain {
  readonly kind = "random";
  readonly model = "uniform-random";
  private readonly rng: Rng;
  private readonly latencyMs: number;

  constructor(cfg: Partial<BrainConfig> & { latencyMs?: number } = {}) {
    this.rng = new Rng(cfg.seed ?? (Date.now() & 0xffffffff));
    this.latencyMs = cfg.latencyMs ?? 0;
  }

  async decide(req: DecisionRequest, opts: DecideOptions = {}): Promise<DecisionResult> {
    const t0 = performance.now();
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    let code: string | null = null;
    // Uniform over snippets; re-draw only when the drawn option is impossible right now.
    for (let i = 0; i < 20 && code === null; i++) code = this.rng.pick(RANDOM_SNIPPETS)(this.rng, req.context);
    const text = "```js\n" + (code ?? "rest()") + "\n```";
    opts.onToken?.(text);
    const latencyMs = performance.now() - t0;
    return { text, latencyMs, tokens: 1, tokensPerSec: 0, estimated: true };
  }

  async health() {
    return { ok: true, detail: "no model: uniform random baseline", models: [this.model] };
  }
}
