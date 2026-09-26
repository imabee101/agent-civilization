/**
 * The monolith's riddles. Pure: a seeded generator, and an answer check.
 *
 * Some riddles have a fixed answer (arithmetic, a word backwards). Others ask
 * about the world as it is at the moment of answering (how many towers stand,
 * whose ruin is newest), so the answer is looked up when someone speaks. A
 * riddle is short, and a small mind or a few lines of code can solve it.
 * Every other riddle asks about the world as it stands, or about the far
 * side of the water. None asks every living node to say a private number.
 * Nothing here
 * judges anyone: an answer matches or it does not.
 */
import type { Rng } from "./rng";

export type RiddleKind =
  | "digits"
  | "product"
  | "backwards"
  | "sequence"
  | "towers"
  | "population"
  | "cache"
  | "newest-ruin"
  | "far-plaque"
  | "far-stash";

export interface Riddle {
  kind: RiddleKind;
  text: string;
  /** Present for riddles whose answer never changes. */
  answer?: string;
  /** Ordinal of this riddle on its stone (1 = the first one carved). */
  no: number;
  /** Tick it was carved. */
  posed: number;
}

/** What the world knows at the moment of an answer. */
export interface RiddleFacts {
  towers: number;
  population: number;
  cacheEntries: number;
  /** Name of the ruin that died most recently, if any ruin exists. */
  newestRuin?: string;
  /** Text of the plaque beyond the water, when this world has a water ring. */
  farPlaque?: string;
  /** Food lying in the open stash beyond the water right now. */
  farStashFood?: number;
}

const WORDS = ["lantern", "spring", "tower", "harvest", "winter", "river", "stone", "forest", "meadow", "ember", "orchard", "beacon"] as const;

const FIXED: RiddleKind[] = ["digits", "product", "backwards", "sequence"];
const LIVE: RiddleKind[] = ["towers", "population", "cache", "newest-ruin"];
const FAR: RiddleKind[] = ["far-plaque", "far-stash"];

/** Lower-case alphanumeric tokens: how both the answer and the spoken words are compared. */
export function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** Carve the next riddle: fixed, then live, then far, and so on; the same kind is never carved twice in a row. A world without a water ring asks a live riddle in place of a far one. */
export function makeRiddle(rng: Rng, no: number, posed: number, facts: RiddleFacts, avoid?: RiddleKind): Riddle {
  const slot = no % 3;
  const group = slot === 1 ? FIXED : slot === 2 ? LIVE : facts.farPlaque !== undefined ? FAR : LIVE;
  const pool = group.filter((k) => k !== avoid && (k !== "newest-ruin" || facts.newestRuin !== undefined));
  const kind = rng.pick(pool);
  const base = { kind, no, posed };
  switch (kind) {
    case "digits": {
      const n = 1000 + rng.int(900000);
      return { ...base, text: `Add up the digits of ${n}.`, answer: String(String(n).split("").reduce((s, d) => s + Number(d), 0)) };
    }
    case "product": {
      const a = 6 + rng.int(24);
      const b = 6 + rng.int(24);
      return { ...base, text: `${a} times ${b}.`, answer: String(a * b) };
    }
    case "backwards": {
      const w = rng.pick(WORDS);
      return { ...base, text: `Read this backwards: ${[...w].reverse().join("").toUpperCase()}.`, answer: w };
    }
    case "sequence": {
      const form = rng.int(3);
      if (form === 0) {
        const a = 2 + rng.int(5);
        return { ...base, text: `What comes next: ${a}, ${a * 2}, ${a * 4}, ${a * 8}, ...`, answer: String(a * 16) };
      }
      if (form === 1) {
        const a = 1 + rng.int(20);
        const d = 3 + rng.int(9);
        return { ...base, text: `What comes next: ${a}, ${a + d}, ${a + 2 * d}, ${a + 3 * d}, ...`, answer: String(a + 4 * d) };
      }
      const s = 1 + rng.int(4);
      return { ...base, text: `What comes next: ${s * s}, ${(s + 1) ** 2}, ${(s + 2) ** 2}, ${(s + 3) ** 2}, ...`, answer: String((s + 4) ** 2) };
    }
    case "towers":
      return { ...base, text: "How many towers stand in this world right now?" };
    case "population":
      return { ...base, text: "How many nodes are alive right now?" };
    case "cache":
      return { ...base, text: "How many entries does the Cache hold right now?" };
    case "newest-ruin":
      return { ...base, text: "Whose ruin is the newest?" };
    case "far-plaque":
      return { ...base, text: "Beyond the water there is another plaque. What is its last word?" };
    case "far-stash":
      return { ...base, text: "How much food lies in the open stash beyond the water right now?" };
  }
}

/** The answer a riddle accepts at this moment, or undefined when the world cannot answer it (no ruins yet). */
export function answerOf(r: Riddle, facts: RiddleFacts): string | undefined {
  switch (r.kind) {
    case "towers":
      return String(facts.towers);
    case "population":
      return String(facts.population);
    case "cache":
      return String(facts.cacheEntries);
    case "newest-ruin":
      return facts.newestRuin;
    case "far-plaque":
      return facts.farPlaque !== undefined ? tokens(facts.farPlaque).at(-1) : undefined;
    case "far-stash":
      return facts.farStashFood !== undefined ? String(Math.round(facts.farStashFood)) : undefined;
    default:
      return r.answer;
  }
}

/** True when any word of what was said is the answer. "the answer is 42" answers 42; "420" does not. */
export function matches(spoken: string, answer: string): boolean {
  const want = tokens(answer);
  if (want.length === 0) return false;
  const said = tokens(spoken);
  if (want.length === 1) return said.includes(want[0]!);
  return said.some((_, i) => want.every((w, j) => said[i + j] === w));
}
