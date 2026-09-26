/**
 * The monolith's riddles. Pure: a seeded generator, and an answer check.
 *
 * Riddles ask about words written in the world or a changing fact on the far
 * side of the water. A riddle is short, and a small mind or a few lines of
 * code can solve it. Nothing here judges anyone: an answer matches or it does
 * not.
 * Nothing here
 * judges anyone: an answer matches or it does not.
 */
import type { Rng } from "./rng";

export type RiddleKind =
  | "near-plaque"
  | "shelf-name"
  | "shelf-word"
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
  /** Text of the plaque beside the cache, when there is one. */
  nearPlaque?: string;
  /** One name written on the shelf. */
  shelfName?: string;
  /** One word from a note on the shelf. */
  shelfWord?: string;
  /** Text of the plaque beyond the water, when this world has a water ring. */
  farPlaque?: string;
  /** Food lying in the open stash beyond the water right now. */
  farStashFood?: number;
}

const NEAR: RiddleKind[] = ["near-plaque", "shelf-name", "shelf-word"];
const FAR: RiddleKind[] = ["far-plaque", "far-stash"];

/** Lower-case alphanumeric tokens: how both the answer and the spoken words are compared. */
export function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

function lastWord(text: string | undefined): string | undefined {
  const words = tokens(text ?? "");
  return words.length ? words[words.length - 1] : undefined;
}

/** Carve the next riddle from a plaque, the shelf, or the far side. The same kind is never carved twice in a row. A world without a water ring stays on this side. */
export function makeRiddle(rng: Rng, no: number, posed: number, facts: RiddleFacts, avoid?: RiddleKind): Riddle {
  const slot = no % 3;
  const group = slot === 0 && facts.farPlaque !== undefined ? FAR : NEAR;
  const pool = group.filter((k) => {
    if (k === avoid) return false;
    if (k === "near-plaque") return lastWord(facts.nearPlaque) !== undefined;
    if (k === "shelf-name") return !!facts.shelfName;
    if (k === "shelf-word") return !!facts.shelfWord;
    if (k === "far-plaque") return lastWord(facts.farPlaque) !== undefined;
    return facts.farStashFood !== undefined;
  });
  const kind = rng.pick(pool.length ? pool : NEAR.filter((k) => k !== avoid));
  const base = { kind, no, posed };
  switch (kind) {
    case "near-plaque":
      return { ...base, text: "The plaque beside the cache has a last word. What is it?" };
    case "shelf-name":
      return { ...base, text: "What is one name written on the shelf?" };
    case "shelf-word":
      return { ...base, text: "Read a note on the shelf. What is one word in it?" };
    case "far-plaque":
      return { ...base, text: "Beyond the water there is another plaque. What is its last word?" };
    case "far-stash":
      return { ...base, text: "How much food lies in the open stash beyond the water right now?" };
  }
}

/** The answer a riddle accepts at this moment, or undefined when the world cannot answer it (no ruins yet). */
export function answerOf(r: Riddle, facts: RiddleFacts): string | undefined {
  switch (r.kind) {
    case "near-plaque":
      return lastWord(facts.nearPlaque);
    case "shelf-name":
      return facts.shelfName;
    case "shelf-word":
      return facts.shelfWord;
    case "far-plaque":
      return lastWord(facts.farPlaque);
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
