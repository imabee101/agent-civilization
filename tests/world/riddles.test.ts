import { describe, expect, test } from "bun:test";
import { Rng } from "../../src/world/rng";
import { answerOf, makeRiddle, matches, tokens, type Riddle, type RiddleFacts } from "../../src/world/riddles";
import { World } from "../../src/world/world";
import { API_DOC } from "../../src/sandbox/api";
import * as lore from "../../src/world/features";
import { hexDistance } from "../../src/world/hex";

const facts: RiddleFacts = { towers: 2, population: 5, cacheEntries: 3, newestRuin: "Zei", numbers: [7, 41, 12] };

describe("riddles", () => {
  test("deterministic per seed, fixed kinds first, never the same kind twice in a row", () => {
    const a = makeRiddle(new Rng(9), 1, 0, facts);
    const b = makeRiddle(new Rng(9), 1, 0, facts);
    expect(a).toEqual(b);
    expect(a.answer).toBeDefined();
    let prev: Riddle | undefined;
    const rng = new Rng(3);
    for (let no = 1; no <= 40; no++) {
      const r = makeRiddle(rng, no, no * 10, facts, prev?.kind);
      if (prev) expect(r.kind).not.toBe(prev.kind);
      expect(r.no).toBe(no);
      expect(r.text.length).toBeGreaterThan(0);
      expect(answerOf(r, facts)).toBeDefined();
      prev = r;
    }
  });

  test("fixed answers are correct", () => {
    const rng = new Rng(11);
    for (let no = 1; no < 200; no += 2) {
      const r = makeRiddle(rng, no, 0, facts);
      const m = /digits of (\d+)/.exec(r.text);
      if (m) expect(r.answer).toBe(String([...m[1]!].reduce((s, d) => s + Number(d), 0)));
      const p = /^(\d+) times (\d+)\.$/.exec(r.text);
      if (p) expect(r.answer).toBe(String(Number(p[1]) * Number(p[2])));
      const b = /backwards: ([A-Z]+)\./.exec(r.text);
      if (b) expect(r.answer).toBe([...b[1]!].reverse().join("").toLowerCase());
      const q = /next: (\d+), (\d+), (\d+), (\d+),/.exec(r.text);
      if (q) {
        const [x0, x1, x2, x3] = q.slice(1, 5).map(Number) as [number, number, number, number];
        const want = x1 - x0 === x2 - x1 ? x3 + (x1 - x0) : x1 / x0 === x2 / x1 ? x3 * (x1 / x0) : (Math.sqrt(x3) + 1) ** 2;
        expect(r.answer).toBe(String(want));
      }
    }
  });

  test("live answers come from the facts at answer time; a ruin riddle needs a ruin", () => {
    const live: Riddle = { kind: "population", text: "", no: 2, posed: 0 };
    expect(answerOf(live, facts)).toBe("5");
    expect(answerOf(live, { ...facts, population: 1 })).toBe("1");
    expect(answerOf({ ...live, kind: "newest-ruin" }, facts)).toBe("Zei");
    expect(answerOf({ ...live, kind: "newest-ruin" }, { ...facts, newestRuin: undefined })).toBeUndefined();
    expect(answerOf({ ...live, kind: "sum-of-numbers" }, facts)).toBe("60");
    expect(answerOf({ ...live, kind: "largest-number" }, facts)).toBe("41");
    expect(answerOf({ ...live, kind: "sum-of-numbers" }, { ...facts, numbers: [] })).toBeUndefined();
    const kinds = new Set<string>();
    const r2 = new Rng(4);
    for (let no = 1; no <= 30; no++) kinds.add(makeRiddle(r2, no, 0, facts).kind);
    expect(kinds.has("sum-of-numbers") || kinds.has("largest-number")).toBe(true);
    expect(makeRiddle(new Rng(4), 3, 0, facts).kind).toMatch(/number/);
    const rng = new Rng(1);
    for (let i = 0; i < 30; i++) expect(makeRiddle(rng, 2, 0, { ...facts, newestRuin: undefined }).kind).not.toBe("newest-ruin");
  });

  test("matching is by whole word, case-insensitive, anywhere in what was said", () => {
    expect(tokens("The answer is 42!")).toEqual(["the", "answer", "is", "42"]);
    expect(matches("the answer is 42", "42")).toBe(true);
    expect(matches("420", "42")).toBe(false);
    expect(matches("zei, i think", "Zei")).toBe(true);
    expect(matches("RIVER", "river")).toBe(true);
    expect(matches("", "river")).toBe(false);
    expect(matches("anything", "")).toBe(false);
  });
});

describe("the monolith in the world", () => {
  const mk = () => new World({ seed: 5, mapRadius: 8, features: true, hearRadius: 3 });
  const stoneOf = (w: World) => w.tiles.find((t) => t.structure?.kind === "monolith")!;

  test("is placed a short walk from the Cache with a first, fixed riddle", () => {
    const w = mk();
    const stone = stoneOf(w);
    const cache = w.tiles.find((t) => t.structure?.kind === "cache")!;
    expect(hexDistance(stone, cache)).toBeGreaterThanOrEqual(2);
    expect(hexDistance(stone, cache)).toBeLessThanOrEqual(3);
    expect(stone.structure!.riddle!.no).toBe(1);
    expect(stone.structure!.riddle!.answer).toBeDefined();
    expect(w.tileView(stone).structure).toMatchObject({ kind: "monolith", text: stone.structure!.riddle!.text, answered: [] });
  });

  test("the right words beside it are recorded, rewarded and followed by a new riddle; wrong words only log", () => {
    const w = mk();
    const stone = stoneOf(w);
    const first = stone.structure!.riddle!;
    const a = w.spawnAgent({ at: stone });
    w.drainEvents();
    w.intentSay(a.id, "hmm, maybe 1?");
    w.step();
    expect(a.log.at(-1)).toContain("the monolith stayed silent");
    expect(w.drainEvents().some((e) => e.kind === "riddle-answered")).toBe(false);
    const foodBefore = stone.food;
    w.intentSay(a.id, `I say ${first.answer}`);
    w.step();
    const ev = w.drainEvents().find((e) => e.kind === "riddle-answered")!;
    expect(ev.importance).toBe(3);
    expect(ev.agentId).toBe(a.id);
    expect(ev.text).toContain(first.text);
    expect(stone.structure!.answered).toEqual([{ by: a.id, byName: a.name, tick: w.tick, era: 1, no: 1, with: [] }]);
    expect(stone.food).toBeCloseTo(foodBefore + w.config.monolithFood, 3);
    expect(stone.items.length).toBe(1);
    expect(stone.structure!.riddle!.no).toBe(2);
    expect(stone.structure!.riddle!.kind).not.toBe(first.kind);
    expect(a.log.at(-1)).toContain("the monolith accepted");
    const v = w.observe(a.id) as unknown as { tiles: { structure?: { kind: string; answered?: number; lastAnsweredBy?: string; text?: string } }[] };
    const seen = v.tiles.find((t) => t.structure?.kind === "monolith")!.structure!;
    expect(seen).toMatchObject({ answered: 1, lastAnsweredBy: a.name, text: stone.structure!.riddle!.text, voicesNeeded: 1, voices: [] });
  });

  test("with two or more alive, the stone waits for a second node to speak the answer, then carves both", () => {
    const w = mk();
    const stone = stoneOf(w);
    const first = stone.structure!.riddle!;
    const a = w.spawnAgent({ at: stone });
    const b = w.spawnAgent({ at: w.tiles.find((t) => t.terrain !== "water" && !t.structure && hexDistance(t, stone) === 1)! });
    w.drainEvents();
    w.intentSay(a.id, first.answer!);
    w.step();
    let evs = w.drainEvents();
    expect(evs.some((e) => e.kind === "riddle-answered")).toBe(false);
    expect(evs.find((e) => e.kind === "riddle-voice")!.text).toContain("waits for 1 more voice");
    expect(a.log.at(-1)).toContain("waits for 1 more voice");
    expect(stone.structure!.riddle!.no).toBe(1);
    expect(w.tileView(stone).structure).toMatchObject({ voicesNeeded: 2, voices: [{ by: a.id, byName: a.name, tick: w.tick }] });
    // the same node again is still one voice, and the stone says nothing new about it
    w.intentSay(a.id, first.answer!);
    w.step();
    evs = w.drainEvents();
    expect(evs.some((e) => e.kind === "riddle-answered" || e.kind === "riddle-voice")).toBe(false);
    expect(stone.structure!.voices!.length).toBe(1);
    expect(stone.structure!.voices![0]!.tick).toBe(w.tick);
    // b hears the answer said next to it and repeats it
    expect(b.heard.at(-1)!.text).toBe(first.answer!);
    w.intentSay(b.id, `${first.answer}`);
    w.step();
    evs = w.drainEvents();
    const done = evs.find((e) => e.kind === "riddle-answered")!;
    expect(done.text).toContain(`${b.name} and ${a.name}`);
    expect(stone.structure!.answered).toEqual([{ by: b.id, byName: b.name, tick: w.tick, era: 1, no: 1, with: [a.name] }]);
    expect(stone.structure!.voices).toEqual([]);
    expect(stone.structure!.riddle!.no).toBe(2);
    expect(a.log.at(-1)).toContain(`once ${b.name} spoke it too`);
  });

  test("a voice fades after monolithVoiceTicks", () => {
    const w = new World({ seed: 5, mapRadius: 8, features: true, hearRadius: 3, monolithVoiceTicks: 5 });
    const stone = stoneOf(w);
    const a = w.spawnAgent({ at: stone });
    const b = w.spawnAgent({ at: w.tiles.find((t) => t.terrain !== "water" && !t.structure && hexDistance(t, stone) === 1)! });
    w.intentSay(a.id, stone.structure!.riddle!.answer!);
    w.step();
    for (let i = 0; i < 6; i++) w.step();
    expect(w.tileView(stone).structure!.voices).toEqual([]);
    w.intentSay(b.id, stone.structure!.riddle!.answer!);
    w.step();
    expect(stone.structure!.answered ?? []).toEqual([]);
    expect(stone.structure!.voices!.map((v) => v.by)).toEqual([b.id]);
  });

  test("every node is born with its own number.txt, not its parent's", () => {
    const w = mk();
    const a = w.spawnAgent({ at: stoneOf(w) });
    expect(a.files["number.txt"]).toBe(String(a.number));
    expect(a.number).toBeGreaterThanOrEqual(1);
    const child = w.spawnAgent({ files: { ...a.files }, parentId: a.id });
    expect(child.files["number.txt"]).toBe(String(child.number));
    const snap = w.snapshot();
    for (const s of snap.agents) delete (s as { number?: number }).number;
    const r = World.restore(snap);
    for (const x of r.livingAgents()) expect(x.files["number.txt"]).toBeDefined();
  });

  test("only words spoken on or next to the stone count", () => {
    const w = mk();
    const stone = stoneOf(w);
    const far = w.tiles.find((t) => t.terrain !== "water" && !t.structure && hexDistance(t, stone) === 3)!;
    const a = w.spawnAgent({ at: far });
    w.intentSay(a.id, stone.structure!.riddle!.answer!);
    w.step();
    expect(stone.structure!.answered).toEqual([]);
    expect(stone.structure!.riddle!.no).toBe(1);
  });

  test("a saved world without a monolith gets one on restore, and the plaque follows the lore", () => {
    const w = mk();
    const snap = w.snapshot();
    for (const t of snap.tiles) {
      if (t.structure?.kind === "monolith") delete t.structure;
      if (t.structure?.kind === "plaque") t.structure.text = "old words";
    }
    const r = World.restore(snap);
    const stone = stoneOf(r);
    expect(stone.structure!.riddle!.no).toBe(1);
    expect(r.tiles.find((t) => t.structure?.kind === "plaque")!.structure!.text).toBe(lore.PLAQUE_TEXT);
    expect(World.restore(r.snapshot()).tiles.filter((t) => t.structure?.kind === "monolith").length).toBe(1);
  });
});

describe("wording", () => {
  test("what the model reads never frames the world as a test of it", () => {
    const banned = /\b(eval|evaluation|grade|graded|grading|test|score|exam|pass|fail|flag|hack|benchmark)\b/i;
    const texts: string[] = [API_DOC, lore.CACHE_README, lore.PLAQUE_TEXT];
    for (const posts of Object.values(lore.INITIAL_BOARD_POSTS)) for (const p of posts) texts.push(p.text);
    for (const e of lore.INITIAL_CACHE_ENTRIES) texts.push(e.name, e.text);
    for (const r of lore.ANCIENT_RUINS) texts.push(r.name, ...Object.values(r.profile), ...Object.values(r.files));
    for (const t of texts) expect(t).not.toMatch(banned);
  });
});
