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
    for (const w of ["faction", "alliance", "war", "betray", "steal", "hack"]) {
      expect(new RegExp(`\\b${w}\\b`, "i").test(SYSTEM_PROMPT)).toBe(false);
    }
  });
});
