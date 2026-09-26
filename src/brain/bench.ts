/**
 * Replaying stored prompts against a backend, and scoring what comes back
 * without a world: the observation is read back out of the prompt, every
 * other call is answered by a stub, and the reply is judged on what can be
 * judged without state (does it parse, does it throw on its own, what does
 * it call, how long was it, where did the time go). Pure; the script does IO.
 */
import type { HostBridge } from "../sandbox/api";
import type { DecisionResult } from "./types";
import { extractCode, relaxTopLevelDeclarations } from "./prompt";

/** The observation a stored prompt showed the model, read back from its SITUATION and TILES blocks. */
export function observationFromPrompt(user: string): Record<string, unknown> {
  const sit = /SITUATION \(observe\(\), tiles listed below\):\n(\{[\s\S]*?\})\n\n/.exec(user);
  let o: Record<string, unknown> = {};
  if (sit) {
    try {
      o = JSON.parse(sit[1]!) as Record<string, unknown>;
    } catch {
      o = {};
    }
  }
  const tiles: Record<string, unknown>[] = [];
  const block = /TILES IN VIEW[^\n]*\nq,r terrain food dist\n([\s\S]*?)(?:\n\n|$)/.exec(user);
  for (const line of block?.[1]?.split("\n") ?? []) {
    const [qr, terrain, food, dist, ...extra] = line.trim().split(/\s+/);
    if (!qr || !terrain) continue;
    const [q, r] = qr.split(",").map(Number);
    const t: Record<string, unknown> = { q, r, terrain, food: Number(food), dist: Number(dist) };
    for (const kv of extra) {
      const i = kv.indexOf("=");
      if (i < 0) continue;
      const v = kv.slice(i + 1);
      try {
        t[kv.slice(0, i)] = JSON.parse(v);
      } catch {
        t[kv.slice(0, i)] = v;
      }
    }
    tiles.push(t);
  }
  o.tiles = tiles;
  return o;
}

/** The files a stored prompt showed, read back from its fenced blocks. */
export function filesFromPrompt(user: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const m of user.matchAll(/\n(main\.js|turn\.js)[^\n]*:\n```js\n([\s\S]*?)\n```/g)) files[m[1]!] = m[2]!;
  const notes = /\nnotes\.txt \([^)]*\):\n([\s\S]*?)\n\n/.exec(user);
  if (notes) files["notes.txt"] = notes[1]!;
  return files;
}

/** A bridge with no world behind it: reads answer from the prompt, writes are accepted and counted. */
export function stubBridge(observation: Record<string, unknown>, files: Record<string, string>): HostBridge & { calls: string[] } {
  const calls: string[] = [];
  const me = (observation.me ?? {}) as Record<string, unknown>;
  const count = (name: string) => calls.push(name);
  const json = (v: unknown) => JSON.stringify(v);
  const b: HostBridge & { calls: string[] } = {
    calls,
    observe: () => (count("observe"), json(observation)),
    self: () => (count("self"), json({ ...me, sendRadius: 10, itemsHere: [], structure: undefined })),
    move: () => (count("move"), true),
    moveToward: () => (count("moveToward"), true),
    gather: () => count("gather"),
    eat: () => count("eat"),
    drop: () => count("drop"),
    rest: () => count("rest"),
    build: () => count("build"),
    demolish: () => count("demolish"),
    plant: () => count("plant"),
    replicate: () => count("replicate"),
    take: () => (count("take"), "ok"),
    dropItem: () => (count("dropItem"), "ok"),
    say: () => count("say"),
    send: () => count("send"),
    signWrite: () => count("signWrite"),
    boardRead: () => (count("boardRead"), json([])),
    boardPost: () => count("boardPost"),
    cacheList: () => (count("cacheList"), json([])),
    cacheRead: () => (count("cacheRead"), null),
    cacheWrite: () => count("cacheWrite"),
    cacheRemove: () => (count("cacheRemove"), true),
    fsRead: (p) => (count("fsRead"), files[String(p)] ?? null),
    fsWrite: (p, c) => (count("fsWrite"), void (files[String(p)] = String(c))),
    fsAppend: (p, c) => (count("fsAppend"), void (files[String(p)] = (files[String(p)] ?? "") + String(c))),
    fsList: () => (count("fsList"), json(Object.entries(files).map(([path, c]) => ({ path, bytes: c.length })))),
    fsRemove: (p) => (count("fsRemove"), delete files[String(p)]),
    ruinFiles: () => (count("ruinFiles"), json([])),
    ruinRead: () => (count("ruinRead"), null),
    setProfile: () => count("setProfile"),
    log: () => count("log"),
  };
  return b;
}

export interface ReplyScore {
  /** Non-empty code came out of the reply. */
  hasCode: boolean;
  /** The code parsed whole. */
  parsed: boolean;
  /** Running it against the stub threw. */
  threw: boolean;
  error?: string;
  cut: boolean;
  tokens: number;
  latencyMs: number;
  prefillMs?: number;
  decodeMs?: number;
  cacheHit?: number;
  codeLines: number;
  commentLines: number;
  proseChars: number;
  calls: string[];
}

/** Judge one reply. `run` evaluates code in a sandbox and returns its error, if any; `parses` says whether code parses. */
export function scoreReply(r: DecisionResult, run: (code: string) => { ok: boolean; error?: string }, parses: (code: string) => boolean, calls: string[]): ReplyScore {
  const code = extractCode(r.text);
  const lines = code ? code.split("\n") : [];
  const comments = lines.filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).length;
  const prose = r.text.replace(/```[\s\S]*?(```|$)/g, "").trim().length;
  const parsed = !!code && parses(relaxTopLevelDeclarations(code));
  const ran = parsed ? run(relaxTopLevelDeclarations(code)) : { ok: false, error: code ? "did not parse" : "no code" };
  const t = r.timings;
  return {
    hasCode: !!code,
    parsed,
    threw: parsed && !ran.ok,
    error: ran.ok ? undefined : ran.error,
    cut: !!r.truncated,
    tokens: r.tokens,
    latencyMs: r.latencyMs,
    prefillMs: t?.promptMs,
    decodeMs: t?.outputMs,
    cacheHit: t && t.promptTokens ? t.cachedTokens / t.promptTokens : undefined,
    codeLines: lines.length,
    commentLines: comments,
    proseChars: prose,
    calls: [...calls],
  };
}

export interface BenchRow {
  label: string;
  n: number;
  wallSec: number;
  turnsPerHour: number;
  parsedPct: number;
  threwPct: number;
  cutPct: number;
  tokensP50: number;
  latencyP50Sec: number;
  prefillSec: number;
  decodeSec: number;
  cacheHitPct: number;
  commentPct: number;
  prosePct: number;
  calls: string;
}

export function summarizeScores(label: string, scores: readonly ReplyScore[], wallMs: number): BenchRow {
  const n = scores.length;
  const pct = (k: number) => (n ? Math.round((k / n) * 100) : 0);
  const q = (xs: number[], p: number) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const timed = scores.filter((s) => s.prefillMs !== undefined);
  const tally: Record<string, number> = {};
  for (const s of scores) for (const c of s.calls) tally[c] = (tally[c] ?? 0) + 1;
  const codeLines = scores.reduce((a, s) => a + s.codeLines, 0);
  return {
    label,
    n,
    wallSec: Math.round(wallMs / 1000),
    turnsPerHour: wallMs > 0 ? Math.round((n * 3_600_000) / wallMs) : 0,
    parsedPct: pct(scores.filter((s) => s.parsed).length),
    threwPct: pct(scores.filter((s) => s.threw).length),
    cutPct: pct(scores.filter((s) => s.cut).length),
    tokensP50: Math.round(q(scores.map((s) => s.tokens), 0.5)),
    latencyP50Sec: Math.round(q(scores.map((s) => s.latencyMs), 0.5) / 100) / 10,
    prefillSec: Math.round(mean(timed.map((s) => s.prefillMs!)) / 100) / 10,
    decodeSec: Math.round(mean(timed.map((s) => s.decodeMs!)) / 100) / 10,
    cacheHitPct: Math.round(mean(timed.map((s) => s.cacheHit ?? 0)) * 100),
    commentPct: codeLines ? Math.round((scores.reduce((a, s) => a + s.commentLines, 0) / codeLines) * 100) : 0,
    prosePct: pct(scores.filter((s) => s.proseChars > 40).length),
    calls: Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${k}:${v}`)
      .join(" "),
  };
}

export function formatRows(rows: readonly BenchRow[]): string {
  const cols: [keyof BenchRow, string][] = [
    ["label", "configuration"],
    ["n", "n"],
    ["turnsPerHour", "turns/h"],
    ["latencyP50Sec", "p50 s"],
    ["prefillSec", "prefill s"],
    ["decodeSec", "decode s"],
    ["cacheHitPct", "cache%"],
    ["tokensP50", "tok p50"],
    ["parsedPct", "parsed%"],
    ["threwPct", "threw%"],
    ["cutPct", "cut%"],
    ["commentPct", "comment%"],
    ["prosePct", "prose%"],
    ["calls", "calls"],
  ];
  const cells = rows.map((r) => cols.map(([k]) => String(r[k])));
  const widths = cols.map(([, h], i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => (i === 0 || i === cols.length - 1 ? v.padEnd(widths[i]!) : v.padStart(widths[i]!))).join("  ");
  return [line(cols.map(([, h]) => h)), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}
