/**
 * Builds the per-turn prompt from raw facts, and pulls executable code back
 * out of whatever the model wrote. No narration, no hints about strategy.
 */
import { API_DOC } from "../sandbox/api";

export interface TurnFacts {
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
Reply with exactly one JavaScript code block:
\`\`\`js
// your code
\`\`\`
It runs immediately inside your node. Keep it small and valid. To keep behaving between turns, write handlers into main.js, e.g.
\`\`\`js
fs.write("main.js", \`
function onTick() { const o = observe(); if (o.me.food < 40 && o.me.inventory.food > 0) eat(10); else if (o.me.tileFood > 0) gather(); else move(Math.floor(Math.random()*6)); }
function onMessage(from, msg) { log("got", from, msg); }
\`);
\`\`\`
Do not explain. Code only.`;

const MAX_FILE_CHARS = 3000;
const MAX_LOG_LINES = 14;

export function buildUserPrompt(f: TurnFacts): string {
  const parts: string[] = [];
  parts.push(`TURN ${f.turn}`);
  parts.push(`SITUATION (observe()):\n${JSON.stringify(f.observation)}`);
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
