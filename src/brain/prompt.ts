/**
 * Builds the per-turn prompt from raw facts, and pulls executable code back
 * out of whatever the model wrote. No narration, no hints about strategy.
 */
import { API_DOC } from "../sandbox/api";

export interface BodyFacts {
  tick: number;
  stomach: number;
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
  /** Completion budget the reply has, told to the model so it can size its answer. */
  maxTokens?: number;
  /** Character budget for this prompt; changing sections shrink until it fits. */
  maxChars?: number;
}

export const SYSTEM_PROMPT = `${API_DOC}

HOW TO ANSWER
Reply with exactly one fenced \`\`\`js code block holding the JavaScript you want to run. A block that only holds comments does nothing.
It runs once, immediately, inside your node. Only what main.js defines keeps running between your turns.
Keep it short: under 40 lines, no comments, no prose. A reply longer than the token budget is cut off, and only the complete lines before the cut run. Do not restate handlers that already work; change only what must change.
Names you declare at the top level persist between turns and may be declared again.
Handlers you define in the block are kept. Do not quote them into a string.
Do not explain. Code only.`;

/** Generation stops before a closing fence: the reply is the one code block, nothing after it. */
export const FENCE_STOP = "\n```";

const MAX_FILE_CHARS = 3000;
const MAX_NOTES_CHARS = 600;
const MAX_LOG_LINES = 14;
const MAX_INBOX_PAYLOAD_CHARS = 240;
const MAX_NODES_SHOWN = 12;
const MAX_RUINS_SHOWN = 8;
/** Roughly how many short lines of code a token budget holds; told to the model as a target. */
const TOKENS_PER_LINE = 12;

const HANDLER_FNS = ["onTick", "onMessage", "onHear"] as const;

/** Drop comments and whitespace so two writings of the same loop compare equal. */
export function normalizeScript(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\s+/g, "");
}

/**
 * The source of one `function name(...) { ... }` declaration, strings and
 * comments skipped, or undefined when the block does not declare it.
 * The last declaration wins.
 */
export function extractHandler(src: string, name: string): { start: number; end: number; text: string } | undefined {
  let found: { start: number; end: number; text: string } | undefined;
  const needle = `function ${name}`;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (src.startsWith(needle, i) && (i === 0 || /[\s;}]/.test(src[i - 1]!))) {
      const after = i + needle.length;
      if (after < src.length && /[A-Za-z0-9_]/.test(src[after]!)) {
        i++;
        continue;
      }
      const brace = src.indexOf("{", after);
      if (brace < 0) break;
      const end = matchBrace(src, brace);
      if (end === undefined) break;
      found = { start: i, end, text: src.slice(i, end) };
      i = end;
      continue;
    }
    i++;
  }
  return found;
}

function skipString(src: string, i: number): number {
  const q = src[i]!;
  i++;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (q === "`" && src[i] === "$" && src[i + 1] === "{") {
      const end = matchBrace(src, i + 1);
      i = end ?? src.length;
      continue;
    }
    if (src[i] === q) return i + 1;
    i++;
  }
  return i;
}

function matchBrace(src: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipStringishComment(src, i) - 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(src, i) - 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

function skipStringishComment(src: string, i: number): number {
  if (src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl < 0 ? src.length : nl + 1;
  }
  const end = src.indexOf("*/", i + 2);
  return end < 0 ? src.length : end + 2;
}

/**
 * Fold handler declarations from a turn block into the stored script.
 * Only the functions the block declares are replaced. Returns null when
 * the block declares none, so a one-shot turn leaves the script alone.
 */
export function mergeHandlers(existing: string, block: string): string | null {
  let next = existing;
  let changed = false;
  for (const name of HANDLER_FNS) {
    const fn = extractHandler(block, name);
    if (!fn) continue;
    changed = true;
    const prev = extractHandler(next, name);
    if (prev) next = next.slice(0, prev.start) + fn.text + next.slice(prev.end);
    else next = `${next.replace(/\s*$/, "")}\n${fn.text}\n`;
  }
  return changed ? next.replace(/^\n/, "") : null;
}

/** Bound what can be unboundedly long in an observation: message payloads, and how many nodes and ruins are listed. */
function compactObservation(o: Record<string, unknown>, limits = { inbox: 8, heard: 8, shelf: 5 }): Record<string, unknown> {
  const out: Record<string, unknown> = { ...o };
  const clip = (v: unknown): unknown => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s === undefined || s.length <= MAX_INBOX_PAYLOAD_CHARS) return v;
    return `${s.slice(0, MAX_INBOX_PAYLOAD_CHARS)}…(${s.length} chars)`;
  };
  if (Array.isArray(out.inbox)) out.inbox = (out.inbox as Record<string, unknown>[]).slice(-limits.inbox).map((m) => ({ ...m, payload: clip(m.payload) }));
  if (Array.isArray(out.heard)) out.heard = (out.heard as Record<string, unknown>[]).slice(-limits.heard);
  if (Array.isArray(out.nodes) && out.nodes.length > MAX_NODES_SHOWN) {
    out.nodes = [...(out.nodes as { dist?: number }[])].sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0)).slice(0, MAX_NODES_SHOWN);
    out.nodesNotShown = (o.nodes as unknown[]).length - MAX_NODES_SHOWN;
  }
  if (Array.isArray(out.ruins) && out.ruins.length > MAX_RUINS_SHOWN) {
    out.ruins = [...(out.ruins as { dist?: number }[])].sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0)).slice(0, MAX_RUINS_SHOWN);
    out.ruinsNotShown = (o.ruins as unknown[]).length - MAX_RUINS_SHOWN;
  }
  if (Array.isArray(out.shelf)) {
    if (limits.shelf <= 0) delete out.shelf;
    else if ((out.shelf as unknown[]).length > limits.shelf) out.shelf = (out.shelf as unknown[]).slice(0, limits.shelf);
  }
  return out;
}

/** One tile as `q,r terrain food dist` plus any other fields as k=v: the same facts in far fewer tokens. */
function tileLine(t: Record<string, unknown>): string {
  const { q, r, terrain, food, dist, ...extra } = t;
  const more = Object.entries(extra).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return [`${String(q)},${String(r)}`, String(terrain), String(food), String(dist), ...more].join(" ");
}

/**
 * Stable facts first (files, code, handlers), changing facts last (turn, body, situation, log):
 * a backend that caches the prompt prefix then re-reads only what changed since the node's last turn.
 */
export function buildUserPrompt(f: TurnFacts): string {
  // Shrink steps, applied in order until the prompt fits its budget: the least useful, most volatile facts go first.
  let limits = { log: MAX_LOG_LINES, tileDist: Infinity, inbox: 8, heard: 8, file: MAX_FILE_CHARS, shelf: 5 };
  const steps: ((l: typeof limits) => typeof limits)[] = [
    (l) => ({ ...l, shelf: 0 }),
    (l) => ({ ...l, log: 6 }),
    (l) => ({ ...l, tileDist: 2 }),
    (l) => ({ ...l, inbox: 4, heard: 4 }),
    (l) => ({ ...l, file: 1500 }),
    (l) => ({ ...l, log: 0, tileDist: 1 }),
    (l) => ({ ...l, file: 800, inbox: 2, heard: 2 }),
  ];
  let text = render(f, limits);
  for (const step of steps) {
    if (f.maxChars === undefined || text.length <= f.maxChars) break;
    limits = step(limits);
    text = render(f, limits);
  }
  return text;
}

function render(f: TurnFacts, limits: { log: number; tileDist: number; inbox: number; heard: number; file: number; shelf: number }): string {
  const parts: string[] = [];
  const me = (f.observation as { me?: { name?: string; originNote?: string } }).me;
  const num = f.files["number.txt"]?.trim();
  if (me?.name) {
    const beside = me.originNote ? ` Beside you: ${me.originNote}` : " Beside you: open ground.";
    parts.push(`You are ${me.name}.${num ? ` Your number is ${num}.` : ""}${beside}`);
  }
  const names = Object.keys(f.files).sort();
  if (names.length === 0) parts.push("FILES: none yet. You have no main.js, so nothing happens between your turns.");
  else {
    const lines = names.map((n) => `- ${n} (${f.files[n]!.length} chars)`);
    parts.push(`FILES:\n${lines.join("\n")}`);
    const show = (name: string, label: string) => {
      const src = f.files[name];
      if (src === undefined) return;
      const shown = src.length > limits.file ? src.slice(0, limits.file) + "\n// ...truncated" : src;
      parts.push(`${label}\n\`\`\`js\n${shown}\n\`\`\``);
    };
    show("main.js", "main.js:");
    const notes = f.files["notes.txt"];
    if (notes !== undefined) parts.push(`notes.txt (yours; the first ${MAX_NOTES_CHARS} characters):\n${notes.slice(0, MAX_NOTES_CHARS)}`);
  }
  parts.push(`ACTIVE HANDLERS: ${f.handlers.length ? f.handlers.join(", ") : "none"}`);
  // turn.js changes every turn, so it sits after everything that does not: a backend caching the prefix keeps main.js.
  // Shown only while it holds handlers main.js does not; once the handlers live in main.js there is nothing new in it.
  const turnSrc = f.files["turn.js"];
  const main = f.files["main.js"] ?? "";
  if (turnSrc !== undefined && f.handlers.some((h) => !new RegExp(`function\\s+${h}\\b`).test(main))) {
    const shown = turnSrc.length > limits.file ? turnSrc.slice(0, limits.file) + "\n// ...truncated" : turnSrc;
    parts.push(`turn.js (the code your last turn ran; its handlers are the active ones):\n\`\`\`js\n${shown}\n\`\`\``);
  }
  parts.push(`TURN ${f.turn}`);
  if (f.since) {
    const { from, to, events } = f.since;
    const d = (k: keyof BodyFacts) => `${k} ${from[k]}->${to[k]}`;
    const happened = Object.entries(events).sort().map(([k, n]) => `${k} x${n}`).join(", ") || "none";
    parts.push(`SINCE YOUR LAST TURN (${to.tick - from.tick} ticks): ${d("stomach")}, ${d("energy")}, ${d("health")}, carried food ${from.carried}->${to.carried}. Your events: ${happened}.`);
  }
  const { tiles, ...rest } = f.observation as { tiles?: Record<string, unknown>[] };
  parts.push(`SITUATION (observe(), tiles listed below):\n${JSON.stringify(compactObservation(rest, { inbox: limits.inbox, heard: limits.heard, shelf: limits.shelf }))}`);
  const shownTiles = tiles?.filter((t) => typeof t.dist !== "number" || t.dist <= limits.tileDist);
  if (shownTiles?.length) parts.push(`TILES IN VIEW (in code: observe().tiles, objects {q,r,terrain,food,dist,...}):\nq,r terrain food dist\n${shownTiles.map(tileLine).join("\n")}`);
  if (f.lastResult !== undefined) parts.push(`LAST TURN RESULT: ${f.lastResult}`);
  if (f.lastError) parts.push(`LAST ERROR: ${f.lastError}`);
  if (f.log.length && limits.log > 0) parts.push(`RECENT LOG:\n${f.log.slice(-limits.log).join("\n")}`);
  if (f.maxTokens !== undefined) parts.push(`REPLY BUDGET: ${f.maxTokens} tokens, about ${Math.max(5, Math.floor(f.maxTokens / TOKENS_PER_LINE))} short lines. Past it, the reply is cut.`);
  parts.push("Your code:");
  return parts.join("\n\n");
}

/**
 * Turn code and main.js run in the node's global scope, where a top-level
 * `const`/`let` would make a lexical binding that a later turn cannot declare
 * again. Declaring them as `var` keeps the promise the prompt makes: what you
 * declare at the top level persists and may be declared again.
 */
export function relaxTopLevelDeclarations(src: string): string {
  // Lines that start at column 0 are taken as top level; on those, a const/let at the line start or after a ';' becomes var.
  return src
    .split("\n")
    .map((line) => (/^\s/.test(line) ? line : line.replace(/(^|;\s*)(const|let)\s+/g, "$1var ")))
    .join("\n");
}

/** The longest prefix of `src`, cut at line ends, that `parses` accepts. Used when a reply was cut off mid-program. */
export function longestParsingPrefix(src: string, parses: (candidate: string) => boolean, maxTries = 80): string | undefined {
  const lines = src.split("\n");
  for (let end = lines.length, tries = 0; end > 0 && tries < maxTries; end--, tries++) {
    const candidate = lines.slice(0, end).join("\n").trimEnd();
    if (candidate.trim().length === 0) continue;
    if (parses(candidate)) return candidate;
  }
  return undefined;
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
