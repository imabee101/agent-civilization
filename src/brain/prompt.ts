/**
 * Builds the per-turn prompt from raw facts, and pulls executable code back
 * out of whatever the model wrote. No narration, no hints about strategy.
 */
import { API_DOC } from "../sandbox/api";

export interface BodyFacts {
  tick: number;
  food: number;
  energy: number;
  health: number;
  carried: number;
}

export interface TurnFacts {
  /** What changed for this node between its previous turn and now. */
  since?: { from: BodyFacts; to: BodyFacts; events: Record<string, number> };
  observation: unknown;
  files: Record<string, string>;
  log: string[];
  lastError?: string;
  lastResult?: string;
  turn: number;
  handlers: string[];
}

export const SYSTEM_PROMPT = `${API_DOC}

HOW TO ANSWER
Reply with exactly one fenced \`\`\`js code block holding the JavaScript you want to run. A block that only holds comments does nothing.
It runs once, immediately, inside your node. Only what main.js defines keeps running between your turns.
Do not explain. Code only.`;

const MAX_FILE_CHARS = 3000;
const MAX_LOG_LINES = 14;

/** One tile as `q,r terrain food dist` plus any other fields as k=v: the same facts in far fewer tokens. */
function tileLine(t: Record<string, unknown>): string {
  const { q, r, terrain, food, dist, ...extra } = t;
  const more = Object.entries(extra).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return [`${String(q)},${String(r)}`, String(terrain), String(food), String(dist), ...more].join(" ");
}

export function buildUserPrompt(f: TurnFacts): string {
  const parts: string[] = [];
  parts.push(`TURN ${f.turn}`);
  if (f.since) {
    const { from, to, events } = f.since;
    const d = (k: keyof BodyFacts) => `${k} ${from[k]}->${to[k]}`;
    const happened = Object.entries(events).sort().map(([k, n]) => `${k} x${n}`).join(", ") || "none";
    parts.push(`SINCE YOUR LAST TURN (${to.tick - from.tick} ticks): ${d("food")}, ${d("energy")}, ${d("health")}, carried food ${from.carried}->${to.carried}. Your events: ${happened}.`);
  }
  const { tiles, ...rest } = f.observation as { tiles?: Record<string, unknown>[] };
  parts.push(`SITUATION (observe(), tiles listed below):\n${JSON.stringify(rest)}`);
  if (tiles?.length) parts.push(`TILES IN VIEW (in code: observe().tiles, objects {q,r,terrain,food,dist,...}):\nq,r terrain food dist\n${tiles.map(tileLine).join("\n")}`);
  const names = Object.keys(f.files).sort();
  if (names.length === 0) parts.push("FILES: none yet. You have no main.js, so nothing happens between your turns.");
  else {
    const lines = names.map((n) => `- ${n} (${f.files[n]!.length} chars)`);
    parts.push(`FILES:\n${lines.join("\n")}`);
    const main = f.files["main.js"];
    if (main !== undefined) {
      const shown = main.length > MAX_FILE_CHARS ? main.slice(0, MAX_FILE_CHARS) + "\n// ...truncated" : main;
      parts.push(`main.js:\n\`\`\`js\n${shown}\n\`\`\``);
    }
  }
  parts.push(`ACTIVE HANDLERS: ${f.handlers.length ? f.handlers.join(", ") : "none"}`);
  if (f.lastResult !== undefined) parts.push(`LAST TURN RESULT: ${f.lastResult}`);
  if (f.lastError) parts.push(`LAST ERROR: ${f.lastError}`);
  if (f.log.length) parts.push(`RECENT LOG:\n${f.log.slice(-MAX_LOG_LINES).join("\n")}`);
  parts.push("Your code:");
  return parts.join("\n\n");
}

/**
 * Extract the code to run from raw model output. Prefers the first fenced
 * block; strips <think> blocks; otherwise uses the whole text. Returns an
 * empty string when there is nothing to run.
 */
export function extractCode(output: string): string {
  let text = output.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!text) return "";
  const fence = /```(?:js|javascript|ts|typescript)?[ \t]*\r?\n([\s\S]*?)```/i.exec(text);
  if (fence) return fence[1]!.trim();
  // A lone opening fence with no closing one (model ran out of tokens).
  const open = /```(?:js|javascript)?[ \t]*\r?\n([\s\S]*)$/i.exec(text);
  if (open) return open[1]!.trim();
  // Inline single backticks around a one-liner.
  const inline = /^`([^`\n]+)`$/.exec(text);
  if (inline) return inline[1]!.trim();
  // Drop obvious prose lines preceding code, e.g. "Here is my code:".
  const lines = text.split("\n");
  while (lines.length > 1 && /^[A-Za-z][^;(){}=]*:$/.test(lines[0]!.trim())) lines.shift();
  text = lines.join("\n").trim();
  return text;
}
