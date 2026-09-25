/**
 * Runtime configuration: CLI flags > environment > defaults.
 *
 *   llmwar --port 3000 --agents 8 --brain llamacpp --base-url http://127.0.0.1:8080 --model tiny
 */
import { brainConfigFromEnv } from "./brain/registry";
import type { BrainConfig } from "./brain/types";
import type { EngineConfig } from "./engine/engine";
import type { WorldConfig } from "./world/world";

export interface AppConfig {
  port: number;
  hostname: string;
  dataDir: string;
  fresh: boolean;
  seed?: number;
  engine: Partial<EngineConfig>;
  brain: Partial<BrainConfig> & { kind?: string };
  help: boolean;
}

export const HELP = `LLM War — a shared world for small self-scripting models

usage: llmwar [options]

  --port <n>            HTTP port (default 3000, env PORT)
  --host <addr>         bind address (default 0.0.0.0)
  --data <dir>          snapshot directory (default ./data, env LLMWAR_DATA)
  --fresh               ignore any saved snapshot and start a new world
  --seed <n>            world seed for a fresh world
  --agents <n>          initial population (default 6)
  --max-agents <n>      population cap (default 24)
  --radius <n>          map radius in hexes (default 12)
  --tick-ms <n>         ms per tick at 1x (default 500)
  --turn-ticks <n>      desired ticks between a node's model turns (default 16)
  --concurrency <n>     brain calls in flight (default 1)
  --snapshot-ticks <n>  ticks between snapshots (default 120, 0 disables)
  --brain <kind>        openai | llamacpp | ollama | random | lmstudio | vllm (env LLMWAR_BRAIN)
  --base-url <url>      backend base URL (env LLMWAR_BASE_URL)
  --model <name>        model name (env LLMWAR_MODEL)
  --api-key <key>       bearer token if the backend needs one (env LLMWAR_API_KEY)
  --max-tokens <n>      completion budget per turn (default 400)
  --temperature <x>     sampling temperature (default 0.7)
  --prompt-format <f>   chatml | llama3 | plain — llama.cpp native only
  --no-stream           disable streaming
  -h, --help            this text

With no --brain, local servers are probed (Ollama :11434, llama-server :8080,
LM Studio :1234, vLLM :8000). If none answers, nodes run on the uniform-random
baseline until you point --brain somewhere.`;

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): AppConfig {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--") && a !== "-h") continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const key = a === "-h" ? "help" : a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else bools.add(key);
  }
  const get = (k: string) => flags.get(k);
  const has = (k: string) => bools.has(k) || flags.has(k);

  const world: Partial<WorldConfig> = {};
  const radius = num(get("radius"));
  if (radius !== undefined) world.mapRadius = Math.max(3, Math.min(40, Math.floor(radius)));
  const seed = num(get("seed")) ?? num(env.LLMWAR_SEED);
  if (seed !== undefined) world.seed = seed >>> 0;

  const engine: Partial<EngineConfig> = { world };
  const set = <K extends keyof EngineConfig>(k: K, v: EngineConfig[K] | undefined) => {
    if (v !== undefined) engine[k] = v;
  };
  set("initialAgents", num(get("agents")) ?? num(env.LLMWAR_AGENTS));
  set("maxAgents", num(get("max-agents")));
  set("tickMs", num(get("tick-ms")) ?? num(env.LLMWAR_TICK_MS));
  set("turnIntervalTicks", num(get("turn-ticks")));
  set("concurrency", num(get("concurrency")) ?? num(env.LLMWAR_CONCURRENCY));
  set("snapshotEveryTicks", num(get("snapshot-ticks")));
  set("maxTokens", num(get("max-tokens")) ?? num(env.LLMWAR_MAX_TOKENS));
  set("temperature", num(get("temperature")) ?? num(env.LLMWAR_TEMPERATURE));

  const brain = brainConfigFromEnv(env);
  if (get("brain")) brain.kind = get("brain");
  if (get("base-url")) brain.baseUrl = get("base-url");
  if (get("model")) brain.model = get("model");
  if (get("api-key")) brain.apiKey = get("api-key");
  const pf = get("prompt-format");
  if (pf === "chatml" || pf === "llama3" || pf === "plain") brain.promptFormat = pf;
  if (has("no-stream")) brain.stream = false;
  if (brain.maxTokens === undefined && engine.maxTokens !== undefined) brain.maxTokens = engine.maxTokens;

  return {
    port: num(get("port")) ?? num(env.PORT) ?? 3000,
    hostname: get("host") ?? env.HOST ?? "0.0.0.0",
    dataDir: get("data") ?? env.LLMWAR_DATA ?? "./data",
    fresh: has("fresh"),
    seed,
    engine,
    brain,
    help: has("help"),
  };
}
