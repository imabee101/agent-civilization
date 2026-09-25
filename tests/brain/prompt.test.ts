import { describe, expect, test } from "bun:test";
import { buildUserPrompt, extractCode, SYSTEM_PROMPT } from "../../src/brain/prompt";
import { API_DOC } from "../../src/sandbox/api";

describe("extractCode", () => {
  test("takes the first fenced block, any language tag", () => {
    expect(extractCode("Sure!\n```js\ngather()\n```\nmore")).toBe("gather()");
    expect(extractCode("```javascript\nmove(1)\n```")).toBe("move(1)");
    expect(extractCode("```\nrest()\n```")).toBe("rest()");
    expect(extractCode("```js\na()\n```\n```js\nb()\n```")).toBe("a()");
  });

  test("strips <think> blocks", () => {
    expect(extractCode("<think>\nshould I...\n</think>\n```js\neat(3)\n```")).toBe("eat(3)");
    expect(extractCode("<THINK>x</THINK>rest()")).toBe("rest()");
  });

  test("handles an unterminated fence", () => {
    expect(extractCode("```js\nsay('hi')\nmove(2)")).toBe("say('hi')\nmove(2)");
  });

  test("falls back to the whole text or inline code", () => {
    expect(extractCode("gather()")).toBe("gather()");
    expect(extractCode("`rest()`")).toBe("rest()");
    expect(extractCode("Here is my code:\ngather()")).toBe("gather()");
    expect(extractCode("   \n")).toBe("");
  });
});

describe("buildUserPrompt", () => {
  test("includes situation, files, handlers, errors and log", () => {
    const p = buildUserPrompt({
      observation: { me: { id: "n0" } },
      files: { "main.js": "function onTick(){}", "notes.txt": "x" },
      log: ["[t1] a", "[t2] b"],
      lastError: "TypeError: boom",
      lastResult: "undefined",
      turn: 3,
      handlers: ["onTick"],
    });
    expect(p).toContain("TURN 3");
    expect(p).toContain('{"me":{"id":"n0"}}');
    expect(p).toContain("- main.js (19 chars)");
    expect(p).toContain("- notes.txt");
    expect(p).toContain("function onTick(){}");
    expect(p).toContain("ACTIVE HANDLERS: onTick");
    expect(p).toContain("LAST ERROR: TypeError: boom");
    expect(p).toContain("[t2] b");
  });

  test("reports what changed since the last turn as plain facts", () => {
    const from = { tick: 10, stomach: 80, energy: 90, health: 100, carried: 0 };
    const to = { tick: 58, stomach: 52, energy: 40, health: 100, carried: 6 };
    const p = buildUserPrompt({ since: { from, to, events: { moved: 30, gathered: 2 } }, observation: {}, files: {}, log: [], turn: 4, handlers: [] });
    expect(p).toContain("SINCE YOUR LAST TURN (48 ticks): stomach 80->52, energy 90->40, health 100->100, carried food 0->6. Your events: gathered x2, moved x30.");
    const idle = buildUserPrompt({ since: { from, to, events: {} }, observation: {}, files: {}, log: [], turn: 4, handlers: [] });
    expect(idle).toContain("Your events: none.");
  });

  test("tiles are listed one per line with their extra fields", () => {
    const p = buildUserPrompt({ observation: { tick: 1, tiles: [{ q: -1, r: 2, terrain: "forest", food: 30, dist: 1, wood: 4, structure: { kind: "sign", text: "hi" } }] }, files: {}, log: [], turn: 1, handlers: [] });
    expect(p).toContain('{"tick":1}');
    expect(p).toContain('-1,2 forest 30 1 wood=4 structure={"kind":"sign","text":"hi"}');
  });

  test("explains when there are no files", () => {
    const p = buildUserPrompt({ observation: {}, files: {}, log: [], turn: 1, handlers: [] });
    expect(p).toContain("FILES: none yet");
    expect(p).toContain("ACTIVE HANDLERS: none");
  });

  test("truncates a huge main.js", () => {
    const p = buildUserPrompt({ observation: {}, files: { "main.js": "x".repeat(10000) }, log: [], turn: 1, handlers: [] });
    expect(p).toContain("truncated");
    expect(p.length).toBeLessThan(6000);
  });

  test("system prompt documents the API and asks for code only", () => {
    expect(SYSTEM_PROMPT).toContain(API_DOC);
    expect(SYSTEM_PROMPT).toContain("Code only");
  });

  test("prompts contain no engine-authored social framing", () => {
    for (const w of ["faction", "alliance", "war", "betray", "steal", "hack", "exploit", "trust no"]) {
      expect(new RegExp(`\\b${w}\\b`, "i").test(SYSTEM_PROMPT)).toBe(false);
    }
  });

  test("the system prompt carries no example strategy", () => {
    const howTo = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("HOW TO ANSWER"));
    for (const call of ["eat(", "gather(", "move(", "say(", "send(", "fs.write("]) expect(howTo).not.toContain(call);
  });

  test("docs/node-api.md carries the model's API reference word for word, once", async () => {
    const doc = await Bun.file(new URL("../../docs/node-api.md", import.meta.url)).text();
    expect(doc.split(API_DOC).length - 1).toBe(1);
  });
});
