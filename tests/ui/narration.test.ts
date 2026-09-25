import { describe, expect, test } from "bun:test";
import type { WorldEvent } from "../../src/shared/protocol";
import { utteranceFor } from "../../ui/lib/narration";

const ev = (over: Partial<WorldEvent>): WorldEvent => ({ id: 1, tick: 1, day: 1, kind: "moved", importance: 1, text: "Ash moved north", ...over });

/** Strip the allowed punctuation/quote joiners and check nothing else was added. */
function onlyLiteral(out: string, e: WorldEvent): boolean {
  let s = out;
  if (e.text) s = s.replace(e.text.trim(), "");
  if (e.quote) s = s.replace(e.quote.trim(), "");
  return /^[\s."…]*$/.test(s);
}

describe("utteranceFor", () => {
  test("speaks literal event text for notable events", () => {
    const e = ev({});
    expect(utteranceFor(e)).toBe("Ash moved north");
  });
  test("skips importance-0 noise by default", () => {
    expect(utteranceFor(ev({ importance: 0 }))).toBeNull();
    expect(utteranceFor(ev({ importance: 0 }), { minImportance: 0 })).toBe("Ash moved north");
  });
  test("appends literal quote for spoke / sent-message only", () => {
    const spoke = ev({ kind: "spoke", text: "Ash said", quote: "is anyone there?" });
    const out = utteranceFor(spoke)!;
    expect(out).toContain("is anyone there?");
    expect(onlyLiteral(out, spoke)).toBe(true);
    // a quote on a non-speech kind is ignored
    const moved = ev({ kind: "moved", quote: "should not be spoken" });
    expect(utteranceFor(moved)).toBe("Ash moved north");
  });
  test("quoted speech is spoken even at importance 0", () => {
    const e = ev({ kind: "spoke", importance: 0, text: "Ash said", quote: "hello" });
    expect(utteranceFor(e)).toBe('Ash said. "hello"');
  });
  test("never invents words: output is composed only of text and quote", () => {
    const samples: WorldEvent[] = [
      ev({ kind: "died", importance: 3, text: "Ash died of starvation" }),
      ev({ kind: "sent-message", text: "Ash sent a message to Bo", quote: '{"hi":1}' }),
      ev({ kind: "spoke", text: "", quote: "just words" }),
      ev({ kind: "executed-code", text: "Ash executed code" }),
    ];
    for (const e of samples) {
      const out = utteranceFor(e);
      expect(out).not.toBeNull();
      expect(onlyLiteral(out!, e)).toBe(true);
    }
  });
  test("empty text and no quote -> silent", () => {
    expect(utteranceFor(ev({ text: "" }))).toBeNull();
    expect(utteranceFor(ev({ text: "   ", kind: "spoke", quote: "" }))).toBeNull();
  });
  test("long text is truncated with an ellipsis", () => {
    const out = utteranceFor(ev({ text: "x".repeat(500) }), { maxChars: 50 })!;
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });
});
