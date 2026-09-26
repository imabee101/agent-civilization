#!/usr/bin/env bun
/**
 * Replay stored prompts against a backend and score the replies, so a model,
 * a sampling setting or a server flag is chosen by numbers, not by feel.
 *
 *   bun scripts/bench-brain.ts --source data/history.sqlite --n 12 --label "q4_0 t0.7"
 *   bun scripts/bench-brain.ts --source https://civ.imabee.com --insecure --base-url http://127.0.0.1:8081/v1 --temperature 0.4 --label "t0.4"
 *
 * Options: --source <sqlite|url> (required)  --n <prompts, default 12>  --offset <skip, default 0>
 *          --base-url (default http://127.0.0.1:8080/v1)  --model  --max-tokens (600)  --temperature (0.7)
 *          --top-p  --min-p  --repeat-penalty  --no-fence-stop  --stored-system (use each prompt's own system text)
 *          --concurrency <1..n, default 1>  --slot-base <first id_slot, default 8>  --label <row name>  --json
 *
 * The user prompts are replayed as stored; the system prompt is the current one unless --stored-system.
 * Scores need no world: the observation is read back from the prompt and the code runs against a stub.
 */
import { filesFromPrompt, formatRows, observationFromPrompt, scoreReply, stubBridge, summarizeScores, type ReplyScore } from "../src/brain/bench";
import { FENCE_STOP, SYSTEM_PROMPT } from "../src/brain/prompt";
import { createBrain } from "../src/brain/registry";
import { HistoryStore } from "../src/engine/history";
import { NodeSandbox } from "../src/sandbox/sandbox";
import type { DecisionRecord } from "../src/shared/protocol";

const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (k: string) => argv.includes(`--${k}`);
const num = (k: string, d?: number) => (opt(k) !== undefined ? Number(opt(k)) : d);
const source = opt("source");
if (!source) {
  console.error("bench-brain: --source <history.sqlite | https://host> is required");
  process.exit(2);
}
const n = num("n", 12)!;
const offset = num("offset", 0)!;
const concurrency = Math.max(1, num("concurrency", 1)!);
const slotBase = num("slot-base", 8)!;
const label = opt("label") ?? `${opt("model") ?? "model"} t${num("temperature", 0.7)}${has("no-fence-stop") ? " nostop" : ""} c${concurrency}`;

async function loadDecisions(): Promise<DecisionRecord[]> {
  if (/^https?:/.test(source!)) {
    const r = await fetch(`${source!.replace(/\/+$/, "")}/api/history/decisions?limit=500`, has("insecure") ? ({ tls: { rejectUnauthorized: false } } as RequestInit) : undefined);
    if (!r.ok) throw new Error(`${source}: ${r.status}`);
    return (await r.json()) as DecisionRecord[];
  }
  const h = new HistoryStore(source!);
  const rows = h.decisions({ limit: 500 });
  h.close();
  return rows;
}

const all = (await loadDecisions()).filter((d) => d.prompt.user.length > 200);
const picked = all.slice(-(n + offset), all.length - offset || undefined).slice(0, n);
if (!picked.length) {
  console.error("bench-brain: no stored prompts to replay");
  process.exit(1);
}
const brain = createBrain({
  kind: "openai",
  baseUrl: opt("base-url") ?? "http://127.0.0.1:8080/v1",
  model: opt("model"),
  maxTokens: num("max-tokens", 600),
  temperature: num("temperature", 0.7),
  topP: num("top-p"),
  minP: num("min-p"),
  repeatPenalty: num("repeat-penalty"),
  timeoutMs: 600_000,
});

async function one(d: DecisionRecord, slot: number): Promise<ReplyScore> {
  const observation = observationFromPrompt(d.prompt.user);
  const files = filesFromPrompt(d.prompt.user);
  const bridge = stubBridge(observation, files);
  const sb = await NodeSandbox.create(bridge);
  try {
    if (files["main.js"]) sb.loadScript(files["main.js"]);
    const r = await brain.decide({ system: has("stored-system") ? d.prompt.system : SYSTEM_PROMPT, user: d.prompt.user, maxTokens: num("max-tokens", 600), slot, ...(has("no-fence-stop") ? {} : { stop: [FENCE_STOP] }) });
    bridge.calls.length = 0;
    const parses = (code: string) => {
      const p = sb.eval(`(function(s){ try { new Function(s); return "ok"; } catch (e) { return "no"; } })(${JSON.stringify(code)})`);
      return p.ok && p.value === "ok";
    };
    return scoreReply(r, (code) => sb.eval(code, "bench.js"), parses, bridge.calls);
  } finally {
    sb.dispose();
  }
}

const t0 = Date.now();
const scores: ReplyScore[] = [];
const queue = [...picked];
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async (_, i) => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      const s = await one(d, slotBase + i);
      scores.push(s);
      process.stderr.write(`${label}: ${scores.length}/${picked.length} ${s.parsed ? (s.threw ? "threw" : "ok") : "no-parse"} ${Math.round(s.latencyMs / 1000)} s ${s.tokens} tok${s.error ? ` (${s.error.slice(0, 60)})` : ""}\n`);
    }
  }),
);
const row = summarizeScores(label, scores, Date.now() - t0);
if (has("json")) console.log(JSON.stringify({ row, scores }));
else console.log(formatRows([row]));
