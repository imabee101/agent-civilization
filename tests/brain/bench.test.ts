import { describe, expect, test } from "bun:test";
import { filesFromPrompt, formatRows, observationFromPrompt, scoreReply, stubBridge, summarizeScores } from "../../src/brain/bench";
import { buildUserPrompt } from "../../src/brain/prompt";
import { NodeSandbox } from "../../src/sandbox/sandbox";

const facts = {
  observation: { tick: 9, me: { id: "n1", name: "Ax", q: 1, r: 2, stomach: 40, energy: 50, health: 100, inventory: { food: 3, wood: 0, stone: 0, items: ["seeds"] }, profile: {} }, nodes: [{ id: "n2", name: "Bo", q: 2, r: 2, dist: 1, profile: {} }], ruins: [], inbox: [], heard: [], tiles: [{ q: 1, r: 2, terrain: "grass", food: 12, dist: 0 }, { q: 2, r: 2, terrain: "rock", food: 0, dist: 1, stone: 4, structure: { kind: "sign", text: "hi" } }] },
  files: { "main.js": "function onTick(){ rest() }", "turn.js": "gather()", "notes.txt": "remember the spring" },
  log: [],
  turn: 3,
  handlers: ["onTick"],
};

describe("bench helpers", () => {
  test("the observation and files come back out of a prompt", () => {
    const user = buildUserPrompt(facts);
    const o = observationFromPrompt(user);
    expect(o.tick).toBe(9);
    expect((o.me as { name: string }).name).toBe("Ax");
    expect(o.tiles).toEqual([
      { q: 1, r: 2, terrain: "grass", food: 12, dist: 0 },
      { q: 2, r: 2, terrain: "rock", food: 0, dist: 1, stone: 4, structure: { kind: "sign", text: "hi" } },
    ]);
    expect(filesFromPrompt(user)).toEqual({ "main.js": "function onTick(){ rest() }", "notes.txt": "remember the spring" });
    expect(observationFromPrompt("nothing here").tiles).toEqual([]);
  });

  test("replies are scored on parse, throw, cut, shape and calls against the stub", async () => {
    const o = observationFromPrompt(buildUserPrompt(facts));
    const bridge = stubBridge(o, { "main.js": "" });
    const sb = await NodeSandbox.create(bridge);
    const parses = (code: string) => {
      const p = sb.eval(`(function(s){ try { new Function(s); return "ok"; } catch (e) { return "no"; } })(${JSON.stringify(code)})`);
      return p.ok && p.value === "ok";
    };
    const run = (code: string) => sb.eval(code, "bench.js");
    const base = { latencyMs: 30_000, tokens: 120, tokensPerSec: 4, estimated: false };
    const good = scoreReply({ ...base, text: "```js\n// plan\nconst t = observe().tiles.find(x => x.stone);\nif (t) moveToward(t.q, t.r);\nsay('hi')\n```", timings: { promptTokens: 2000, cachedTokens: 500, promptMs: 8000, outputTokens: 120, outputMs: 20_000 } }, run, parses, bridge.calls);
    expect(good).toMatchObject({ hasCode: true, parsed: true, threw: false, cut: false, codeLines: 4, commentLines: 1, proseChars: 0, prefillMs: 8000, decodeMs: 20_000, cacheHit: 0.25 });
    expect(good.calls).toEqual(["observe", "moveToward", "say"]);
    bridge.calls.length = 0;
    const bad = scoreReply({ ...base, text: "Here is my plan for this turn, in some detail.\n```js\nme.say('x')\n```\nThat should work well enough.", truncated: false }, run, parses, bridge.calls);
    expect(bad).toMatchObject({ parsed: true, threw: true });
    expect(bad.proseChars).toBeGreaterThan(40);
    expect(bad.error).toContain("me.say is not a thing");
    const cut = scoreReply({ ...base, text: "```js\nfunction onTick() {\n  rest(", truncated: true }, run, parses, bridge.calls);
    expect(cut).toMatchObject({ hasCode: true, parsed: false, threw: false, cut: true, error: "did not parse" });
    const none = scoreReply({ ...base, text: "" }, run, parses, bridge.calls);
    expect(none).toMatchObject({ hasCode: false, parsed: false, error: "no code" });
    const row = summarizeScores("x", [good, bad, cut, none], 120_000);
    expect(row).toMatchObject({ n: 4, wallSec: 120, turnsPerHour: 120, parsedPct: 50, threwPct: 25, cutPct: 25, tokensP50: 120, latencyP50Sec: 30, prefillSec: 8, decodeSec: 20, cacheHitPct: 25, prosePct: 25 });
    expect(row.calls).toContain("observe:1");
    const text = formatRows([row]);
    expect(text.split("\n").length).toBe(3);
    expect(text).toContain("turns/h");
    sb.dispose();
  });
});
