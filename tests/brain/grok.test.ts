import { describe, expect, test } from "bun:test";
import { GrokBrain, type Spawner } from "../../src/brain/grok";
import { createBrain } from "../../src/brain/registry";

/** A spawner that records argv and env and prints the given NDJSON lines, split mid-line to cross chunk boundaries. */
function fakeSpawn(lines: object[], exit = 0) {
  const calls: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  const spawn: Spawner = (argv, opts) => {
    calls.push({ argv, env: opts.env });
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const enc = new TextEncoder();
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        const mid = Math.floor(body.length / 2);
        c.enqueue(enc.encode(body.slice(0, mid)));
        c.enqueue(enc.encode(body.slice(mid)));
        c.close();
      },
    });
    return { stdout, exited: Promise.resolve(exit), kill() {} };
  };
  return { spawn, calls };
}

const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const thinking = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } };
const result = (text: string, extra: object = {}) => ({ type: "result", is_error: false, result: text, stop_reason: "end_turn", total_cost_usd: 0.004, usage: { input_tokens: 4000, output_tokens: 12 }, ...extra });

describe("GrokBrain", () => {
  test("is registered as grok", () => {
    expect(createBrain({ kind: "grok" }).kind).toBe("grok");
  });

  test("streams text deltas, skips thinking, and returns the final result", async () => {
    const { spawn } = fakeSpawn([thinking, delta("```js\n"), delta("rest();\n```"), result("```js\nrest();\n```")]);
    const b = new GrokBrain({ kind: "grok", spawn });
    const tokens: string[] = [];
    const r = await b.decide({ system: "SYS", user: "USER" }, { onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(["```js\n", "rest();\n```"]);
    expect(r.text).toBe("```js\nrest();\n```");
    expect(r.tokens).toBe(12);
    expect(r.estimated).toBe(false);
    expect(b.costUsd).toBeCloseTo(0.004);
  });

  test("replaces Grok's system prompt, turns off tools and memory, and runs one turn", async () => {
    const { spawn, calls } = fakeSpawn([result("ok")]);
    await new GrokBrain({ kind: "grok", model: "grok-4.6", reasoningEffort: "medium", spawn }).decide({ system: "SYS", user: "USER" });
    const { argv, env } = calls[0]!;
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(after("-p")).toBe("USER");
    expect(after("--system-prompt-override")).toBe("SYS");
    expect(after("-m")).toBe("grok-4.6");
    expect(after("--reasoning-effort")).toBe("medium");
    expect(after("--max-turns")).toBe("1");
    expect(after("--disallowed-tools")).toBe("read_file,search_tool,use_tool");
    expect(argv).toContain("--disable-web-search");
    expect(env.GROK_MEMORY).toBe("0");
  });

  test("an error result, a missing result, or an empty reply is a BrainError", async () => {
    const err = new GrokBrain({ kind: "grok", spawn: fakeSpawn([result("rate limited", { is_error: true })]).spawn });
    await expect(err.decide({ system: "", user: "u" })).rejects.toThrow("grok: rate limited");
    const turns = new GrokBrain({ kind: "grok", spawn: fakeSpawn([{ type: "result", is_error: true, subtype: "error_max_turns", errors: ["Reached the maximum number of turns"] }]).spawn });
    await expect(turns.decide({ system: "", user: "u" })).rejects.toThrow("grok: Reached the maximum number of turns");
    const none = new GrokBrain({ kind: "grok", spawn: fakeSpawn([], 1).spawn });
    await expect(none.decide({ system: "", user: "u" })).rejects.toThrow("without a result");
    const empty = new GrokBrain({ kind: "grok", spawn: fakeSpawn([result("  ")]).spawn });
    await expect(empty.decide({ system: "", user: "u" })).rejects.toThrow("empty reply");
  });

  test("probe classes a hosted model as fast", async () => {
    const p = await new GrokBrain({ kind: "grok", spawn: fakeSpawn([result("ok")]).spawn }).probe();
    expect(p?.kind).toBe("fast");
    expect(p?.cacheable).toBe(false);
  });
});
