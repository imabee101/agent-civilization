import { describe, expect, test } from "bun:test";
import { buildUserPrompt, extractCode, longestParsingPrefix, relaxTopLevelDeclarations, SYSTEM_PROMPT } from "../../src/brain/prompt";
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

  test("turn.js is shown after main.js with what it is", () => {
    const p = buildUserPrompt({ observation: {}, files: { "main.js": "// m", "turn.js": "function onTick(){ rest() }" }, log: [], turn: 2, handlers: ["onTick"] });
    expect(p.indexOf("main.js:")).toBeLessThan(p.indexOf("turn.js (the code your last turn ran; its handlers are the active ones):"));
    expect(p).toContain("function onTick(){ rest() }");
  });

  test("stable facts come first so a cached prompt prefix survives between turns", () => {
    const p = buildUserPrompt({ observation: { tick: 9 }, files: { "main.js": "function onTick(){}" }, log: ["[t1] a"], turn: 3, handlers: ["onTick"] });
    const at = (s: string) => p.indexOf(s);
    expect(at("FILES:")).toBeLessThan(at("ACTIVE HANDLERS"));
    expect(at("ACTIVE HANDLERS")).toBeLessThan(at("TURN 3"));
    expect(at("TURN 3")).toBeLessThan(at("SITUATION"));
    expect(at("SITUATION")).toBeLessThan(at("RECENT LOG"));
    expect(p.endsWith("Your code:")).toBe(true);
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

  test("bounds message payloads and node lists in the situation", () => {
    const big = "y".repeat(1000);
    const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, dist: 20 - i }));
    const p = buildUserPrompt({ observation: { inbox: [{ from: "a", payload: { blob: big } }], nodes }, files: {}, log: [], turn: 1, handlers: [] });
    expect(p).not.toContain(big);
    expect(p).toContain("…(1011 chars)");
    expect(p).toContain('"nodesNotShown":8');
    expect(p).toContain('"id":"n19","dist":1');
    expect(p).not.toContain('"id":"n0"');
  });

  test("shrinks to a character budget: log first, then far tiles, then messages, then files", () => {
    const tiles = Array.from({ length: 37 }, (_, i) => ({ q: i, r: 0, terrain: "grass", food: 1, dist: i % 4 }));
    const facts = {
      observation: { tiles, inbox: Array.from({ length: 8 }, (_, i) => ({ from: `n${i}`, payload: "m".repeat(100) })) },
      files: { "main.js": "a".repeat(3000), "turn.js": "b".repeat(3000) },
      log: Array.from({ length: 14 }, (_, i) => `log ${i} ${"z".repeat(80)}`),
      turn: 2,
      handlers: [],
    };
    const full = buildUserPrompt(facts);
    const mid = buildUserPrompt({ ...facts, maxChars: full.length - 500 });
    expect(mid.length).toBeLessThan(full.length);
    expect(mid).not.toContain("log 0 ");
    expect(mid).toContain("log 13 ");
    expect(mid).toContain("a".repeat(3000));
    const small = buildUserPrompt({ ...facts, maxChars: 3000 });
    expect(small.length).toBeLessThan(mid.length);
    expect(small).not.toContain("RECENT LOG");
    expect(small).not.toContain("a".repeat(1000));
    expect(small).toContain("// ...truncated");
    expect(small.split("\n").filter((l) => /^\d+,0 grass/.test(l)).length).toBeLessThan(37);
    expect(small.endsWith("Your code:")).toBe(true);
  });

  test("relaxTopLevelDeclarations turns column-0 const/let into var and leaves nested ones alone", () => {
    expect(relaxTopLevelDeclarations("const a = 1;\nlet b = 2;\nfunction f() {\n  const c = 3;\n  let d = 4;\n}\nconstant = 5;")).toBe("var a = 1;\nvar b = 2;\nfunction f() {\n  const c = 3;\n  let d = 4;\n}\nconstant = 5;");
    expect(relaxTopLevelDeclarations("const a = 1; let b = 2; for (let i = 0; i < 2; i++) {}")).toBe("var a = 1; var b = 2; for (let i = 0; i < 2; i++) {}");
  });

  test("longestParsingPrefix cuts at line ends until the parser accepts", () => {
    const parses = (s: string) => !s.includes("{") || s.split("{").length === s.split("}").length;
    expect(longestParsingPrefix("a();\nb();\nfunction f() {\n  c();", parses)).toBe("a();\nb();");
    expect(longestParsingPrefix("function f() {\n  c();", parses)).toBeUndefined();
    expect(longestParsingPrefix("a();\n\n", parses)).toBe("a();");
  });

  test("the answer rules ask for short code and explain what persists", () => {
    const howTo = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("HOW TO ANSWER"));
    expect(howTo).toContain("under 40 lines");
    expect(howTo).toContain("cut off");
    expect(howTo).toContain("persist between turns and may be declared again");
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
