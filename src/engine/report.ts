/**
 * The numbers a record of turns yields: where time went, how replies ended,
 * what the code called, and what threw. Pure; the script feeds it rows from
 * history.sqlite or from a running game's API. Nothing here judges a turn.
 */
import type { DecisionRecord, WorldEvent } from "../shared/protocol";

export interface Report {
  decisions: number;
  failedAtBrain: number;
  cutOff: number;
  codeErrors: number;
  latencyP50Ms: number;
  latencyP90Ms: number;
  tokensP50: number;
  /** From backend timings, when present: mean prompt tokens, cache share, mean seconds in prefill and decode. */
  timed: number;
  promptTokensMean: number;
  cacheHit: number;
  prefillSecMean: number;
  decodeSecMean: number;
  promptCharsP50: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
  apiCalls: Record<string, number>;
  errorClasses: Record<string, number>;
  turnsPerNode: Record<string, number>;
  eventsByKind: Record<string, number>;
  spanHours: number;
  decisionsPerHour: number;
}

const API_CALL = /\b(observe|move|moveToward|gather|eat|drop|rest|build|demolish|plant|replicate|take|dropItem|say|send|cache\.\w+|fs\.\w+|ruins\.\w+|me\.set|board\.\w+|sign\.write|hash|log)\s*\(/g;

export function q(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

/** Errors with their numbers and ids blurred, so the same mistake counts as one class. */
export function errorClass(text: string): string {
  return text.replace(/\d+/g, "N").replace(/'[^']*'/g, "'…'").replace(/\(at .*$/, "").trim().slice(0, 80);
}

export function summarize(decisions: readonly DecisionRecord[], events: readonly WorldEvent[] = []): Report {
  const failedAtBrain = decisions.filter((d) => d.error && !d.code && !/cut off/.test(d.error)).length;
  const cutOff = decisions.filter((d) => /cut off at the .*token limit/.test(d.error ?? "")).length;
  const codeErrors = decisions.filter((d) => d.error && d.code && !/cut off/.test(d.error)).length;
  const answered = decisions.filter((d) => !d.error || d.code);
  const timed = decisions.filter((d) => d.timings);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;
  const apiCalls: Record<string, number> = {};
  for (const d of decisions) {
    for (const line of (d.code ?? "").split("\n")) {
      if (!d.code) break;
      codeLines++;
      const t = line.trim();
      if (!t) blankLines++;
      else if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) commentLines++;
      for (const m of t.matchAll(API_CALL)) apiCalls[m[1]!] = (apiCalls[m[1]!] ?? 0) + 1;
    }
  }
  const errorClasses: Record<string, number> = {};
  for (const d of decisions) if (d.error) errorClasses[errorClass(d.error)] = (errorClasses[errorClass(d.error)] ?? 0) + 1;
  // Handler errors happen between turns and have no decision row; code errors are already on their decision.
  for (const e of events) {
    if (e.kind !== "handler-error") continue;
    const k = errorClass(String(e.data?.error ?? e.text));
    errorClasses[k] = (errorClasses[k] ?? 0) + 1;
  }
  const turnsPerNode: Record<string, number> = {};
  for (const d of decisions) turnsPerNode[d.agentName] = (turnsPerNode[d.agentName] ?? 0) + 1;
  const eventsByKind: Record<string, number> = {};
  for (const e of events) eventsByKind[e.kind] = (eventsByKind[e.kind] ?? 0) + 1;
  const t0 = decisions.length ? Math.min(...decisions.map((d) => d.startedAt)) : 0;
  const t1 = decisions.length ? Math.max(...decisions.map((d) => d.finishedAt)) : 0;
  const spanHours = Math.max(0, t1 - t0) / 3_600_000;
  return {
    decisions: decisions.length,
    failedAtBrain,
    cutOff,
    codeErrors,
    latencyP50Ms: Math.round(q(answered.map((d) => d.latencyMs), 0.5)),
    latencyP90Ms: Math.round(q(answered.map((d) => d.latencyMs), 0.9)),
    tokensP50: Math.round(q(answered.map((d) => d.tokens ?? 0), 0.5)),
    timed: timed.length,
    promptTokensMean: Math.round(mean(timed.map((d) => d.timings!.promptTokens))),
    cacheHit: Math.round(mean(timed.map((d) => (d.timings!.promptTokens ? d.timings!.cachedTokens / d.timings!.promptTokens : 0))) * 100) / 100,
    prefillSecMean: Math.round(mean(timed.map((d) => d.timings!.promptMs)) / 100) / 10,
    decodeSecMean: Math.round(mean(timed.map((d) => d.timings!.outputMs)) / 100) / 10,
    promptCharsP50: Math.round(q(decisions.map((d) => d.prompt.user.length + d.prompt.system.length), 0.5)),
    codeLines,
    commentLines,
    blankLines,
    apiCalls,
    errorClasses,
    turnsPerNode,
    eventsByKind,
    spanHours: Math.round(spanHours * 10) / 10,
    decisionsPerHour: spanHours > 0 ? Math.round((decisions.length / spanHours) * 10) / 10 : 0,
  };
}

/** The report as lines of text: one fact per line, the tallies as sorted `key:count` runs. */
export function formatReport(r: Report): string {
  const top = (o: Record<string, number>, n = 12) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${v}  ${k}`)
      .join("\n    ");
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
  return [
    `decisions ${r.decisions} over ${r.spanHours} h (${r.decisionsPerHour} per hour)`,
    `  failed at the brain ${r.failedAtBrain} (${pct(r.failedAtBrain, r.decisions)}) · cut off ${r.cutOff} (${pct(r.cutOff, r.decisions)}) · code threw ${r.codeErrors} (${pct(r.codeErrors, r.decisions)})`,
    `  latency p50 ${(r.latencyP50Ms / 1000).toFixed(1)} s · p90 ${(r.latencyP90Ms / 1000).toFixed(1)} s · output tokens p50 ${r.tokensP50} · prompt chars p50 ${r.promptCharsP50}`,
    r.timed ? `  backend timings on ${r.timed}: prompt tokens ${r.promptTokensMean} · cache hit ${Math.round(r.cacheHit * 100)}% · prefill ${r.prefillSecMean} s · decode ${r.decodeSecMean} s per turn` : "  backend timings: none recorded",
    `  code lines ${r.codeLines}: comments ${pct(r.commentLines, r.codeLines)}, blank ${pct(r.blankLines, r.codeLines)}`,
    `  api calls:\n    ${top(r.apiCalls, 20) || "none"}`,
    `  errors:\n    ${top(r.errorClasses) || "none"}`,
    `  turns per node:\n    ${top(r.turnsPerNode, 40) || "none"}`,
    `  events:\n    ${top(r.eventsByKind, 30) || "none"}`,
  ].join("\n");
}
