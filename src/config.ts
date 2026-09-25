/**
 * Runtime configuration: CLI flags > environment > defaults.
 *
 *   agentciv --port 3000 --agents 8 --brain llamacpp --base-url http://127.0.0.1:8080 --model tiny
 */
import { brainConfigFromEnv } from "./brain/registry";
import type { BrainConfig } from "./brain/types";
import type { EngineConfig } from "./engine/engine";
import type { WorldConfig } from "./world/world";

export interface AppConfig {
  port: number;
  hostname: string;
  /** PEM paths; both set means HTTPS/WSS is served in-process. */
  tls?: { cert: string; key: string };
  /** Required on every control route and control message when set; from a file so it never shows in a process list. */
  operatorToken?: string;
  operatorTokenFile?: string;
  dataDir: string;
  fresh: boolean;
  /** Keep every event and decision in data/history.sqlite. */
  history: boolean;
  backupsToKeep: number;
  seed?: number;
  engine: Partial<EngineConfig>;
  brain: Partial<BrainConfig> & { kind?: string };
  help: boolean;
}

export const HELP = `Agent Civilization — a shared world for small self-scripting models

usage: agentciv [options]

  --port <n>            HTTP port (default 3000, env PORT)
  --host <addr>         bind address (default 0.0.0.0)
  --tls-cert <file>     PEM chain; with --tls-key serves HTTPS/WSS (env AGENTCIV_TLS_CERT)
  --tls-key <file>      PEM private key (env AGENTCIV_TLS_KEY)
  --operator-token-file <file>  file holding the token every control (pause, spawn, quarantine, reset, ...)
                        must carry (env AGENTCIV_OPERATOR_TOKEN_FILE); --operator-token <t> / AGENTCIV_OPERATOR_TOKEN
                        give it inline. Unset: anyone who can reach the server holds the switch.
  --data <dir>          snapshot directory (default ./data, env AGENTCIV_DATA)
  --fresh               ignore any saved snapshot and start a new world
  --no-history          do not keep the SQLite history of events and decisions
  --backups <n>         hourly snapshot backups to keep (default 48)
  --seed <n>            world seed for a fresh world
  --agents <n>          initial population (default 6)
  --max-agents <n>      population cap for spawn and replicate() (default 64)
  --floor <n>           below this many living nodes a newcomer arrives (default 4, 0 = never)
  --arrival-ticks <n>   ticks between newcomers while under the floor (default 60)
  --season-days <n>     days per season (default 3)
  --radius <n>          map radius in hexes (default 16; the water ring sits at half of it)
  --tick-ms <n>         ms per tick at 1x (default 500)
  --turn-ticks <n>      desired ticks between a node's model turns (default 16)
  --max-tick-ms <n>     slow ticks up to this so a slow brain keeps --turn-ticks (default 5000, 0 = fixed clock)
  --concurrency <n>     most brain calls in flight (default 1); the level used is measured, up to this
  --slots <n>           backend slots to pin nodes to, one per living node (default: what the backend reports)
  --snapshot-ticks <n>  ticks between snapshots (default 120, 0 disables)
  --brain <kind>        openai | llamacpp | ollama | random | lmstudio | vllm (env AGENTCIV_BRAIN)
  --base-url <url>      backend base URL (env AGENTCIV_BASE_URL)
  --model <name>        model name (env AGENTCIV_MODEL)
  --api-key <key>       bearer token if the backend needs one (env AGENTCIV_API_KEY)
  --max-tokens <n>      completion budget per turn (default 400)
  --prompt-chars <n>    character budget for the changing part of a turn prompt (default: from the backend's context, else 12000; 0 = no limit)
  --temperature <x>     sampling temperature (default 0.7)
  --top-p <x>           nucleus sampling, sent only when set (env AGENTCIV_TOP_P)
  --min-p <x>           min-p sampling, sent only when set (env AGENTCIV_MIN_P)
  --repeat-penalty <x>  repetition penalty, sent only when set (env AGENTCIV_REPEAT_PENALTY)
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
  const seed = num(get("seed")) ?? num(env.AGENTCIV_SEED);
  if (seed !== undefined) world.seed = seed >>> 0;

  const engine: Partial<EngineConfig> = { world };
  const set = <K extends keyof EngineConfig>(k: K, v: EngineConfig[K] | undefined) => {
    if (v !== undefined) engine[k] = v;
  };
  set("initialAgents", num(get("agents")) ?? num(env.AGENTCIV_AGENTS));
  const maxAgents = num(get("max-agents"));
  set("maxAgents", maxAgents);
  set("arrivalFloor", num(get("floor")));
  set("arrivalEveryTicks", num(get("arrival-ticks")));
  if (maxAgents !== undefined) world.maxPopulation = Math.max(1, Math.floor(maxAgents));
  const seasonDays = num(get("season-days"));
  if (seasonDays !== undefined) world.seasonDays = Math.max(1, Math.floor(seasonDays));
  set("tickMs", num(get("tick-ms")) ?? num(env.AGENTCIV_TICK_MS));
  set("turnIntervalTicks", num(get("turn-ticks")));
  set("maxTickMs", num(get("max-tick-ms")));
  set("concurrency", num(get("concurrency")) ?? num(env.AGENTCIV_CONCURRENCY));
  set("slots", num(get("slots")));
  set("snapshotEveryTicks", num(get("snapshot-ticks")));
  set("maxTokens", num(get("max-tokens")) ?? num(env.AGENTCIV_MAX_TOKENS));
  set("promptMaxChars", num(get("prompt-chars")) ?? num(env.AGENTCIV_PROMPT_CHARS));
  set("temperature", num(get("temperature")) ?? num(env.AGENTCIV_TEMPERATURE));

  const brain = brainConfigFromEnv(env);
  if (get("brain")) brain.kind = get("brain");
  if (get("base-url")) brain.baseUrl = get("base-url");
  if (get("model")) brain.model = get("model");
  if (get("api-key")) brain.apiKey = get("api-key");
  if (num(get("top-p")) !== undefined) brain.topP = num(get("top-p"));
  if (num(get("min-p")) !== undefined) brain.minP = num(get("min-p"));
  if (num(get("repeat-penalty")) !== undefined) brain.repeatPenalty = num(get("repeat-penalty"));
  const pf = get("prompt-format");
  if (pf === "chatml" || pf === "llama3" || pf === "plain") brain.promptFormat = pf;
  if (has("no-stream")) brain.stream = false;
  if (brain.maxTokens === undefined && engine.maxTokens !== undefined) brain.maxTokens = engine.maxTokens;

  const cert = get("tls-cert") ?? env.AGENTCIV_TLS_CERT;
  const key = get("tls-key") ?? env.AGENTCIV_TLS_KEY;
  if (Boolean(cert) !== Boolean(key)) throw new Error("--tls-cert and --tls-key must be given together");

  const operatorToken = get("operator-token") ?? env.AGENTCIV_OPERATOR_TOKEN;
  const operatorTokenFile = get("operator-token-file") ?? env.AGENTCIV_OPERATOR_TOKEN_FILE;
  return {
    port: num(get("port")) ?? num(env.PORT) ?? 3000,
    operatorToken: operatorToken || undefined,
    operatorTokenFile: operatorTokenFile || undefined,
    hostname: get("host") ?? env.HOST ?? "0.0.0.0",
    tls: cert && key ? { cert, key } : undefined,
    dataDir: get("data") ?? env.AGENTCIV_DATA ?? "./data",
    fresh: has("fresh"),
    history: !has("no-history") && env.AGENTCIV_HISTORY !== "0",
    backupsToKeep: num(get("backups")) ?? 48,
    seed,
    engine,
    brain,
    help: has("help"),
  };
}
