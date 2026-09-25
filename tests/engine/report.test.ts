import { describe, expect, test } from "bun:test";
import { errorClass, formatReport, summarize } from "../../src/engine/report";
import type { DecisionRecord, WorldEvent } from "../../src/shared/protocol";

const dec = (id: number, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id,
  tick: id,
  agentId: "n0",
  agentName: "A",
  backend: "b",
  model: "m",
  prompt: { system: "S".repeat(100), user: "U".repeat(200) },
  output: "```js\nrest()\n```",
  code: "rest()",
  latencyMs: 10_000 + id * 1000,
  tokens: 100,
  startedAt: 3_600_000 * id,
  finishedAt: 3_600_000 * id + 10_000,
  ...over,
});

describe("report", () => {
  test("sums a record of turns: outcomes, latency, timings, code shape, calls, errors, events", () => {
    const decisions = [
      dec(1, { code: "// think\nobserve();\nsay('hi')\n\ngather()", timings: { promptTokens: 2000, cachedTokens: 1000, promptMs: 8000, outputTokens: 100, outputMs: 12_000 } }),
      dec(2, { error: "reply cut off at the 600-token limit; nothing ran", code: undefined, output: "```js\nrest(" }),
      dec(3, { error: "http://x responded 503: loading", code: undefined, output: "" }),
      dec(4, { error: "Error: plant() needs seeds (at <anonymous> (prelude.js))", agentName: "B" }),
    ];
    const events: WorldEvent[] = [
      { id: 1, tick: 1, day: 1, kind: "handler-error", importance: 0, text: "A's onTick threw", data: { error: "Error: send: no living node with id nv (at onTick (turn3.js:2))" } },
      { id: 2, tick: 2, day: 1, kind: "spoke", importance: 1, text: "A said something" },
    ];
    const r = summarize(decisions, events);
    expect(r).toMatchObject({ decisions: 4, failedAtBrain: 1, cutOff: 1, codeErrors: 1, timed: 1, promptTokensMean: 2000, cacheHit: 0.5, prefillSecMean: 8, decodeSecMean: 12, spanHours: 3, tokensP50: 100 });
    expect(r.codeLines).toBe(6);
    expect(r.commentLines).toBe(1);
    expect(r.blankLines).toBe(1);
    expect(r.apiCalls).toEqual({ observe: 1, say: 1, gather: 1, rest: 1 });
    expect(r.errorClasses["reply cut off at the N-token limit; nothing ran"]).toBe(1);
    expect(r.errorClasses["Error: send: no living node with id nv"]).toBe(1);
    expect(r.turnsPerNode).toEqual({ A: 3, B: 1 });
    expect(r.eventsByKind).toEqual({ "handler-error": 1, spoke: 1 });
    expect(r.decisionsPerHour).toBeCloseTo(1.3, 1);
    const text = formatReport(r);
    expect(text).toContain("decisions 4 over 3 h");
    expect(text).toContain("cache hit 50%");
    expect(text).toContain("comments 17%");
    expect(summarize([]).decisionsPerHour).toBe(0);
  });

  test("error classes blur numbers, quoted names and stack positions", () => {
    expect(errorClass("SyntaxError: redeclaration of 'monolithTile' (at turn7.js:3)")).toBe("SyntaxError: redeclaration of '…'");
    expect(errorClass("http://127.0.0.1:8080/v1/chat/completions responded 503: {\"error\"")).toBe("http://N.N.N.N:N/vN/chat/completions responded N: {\"error\"");
  });
});
