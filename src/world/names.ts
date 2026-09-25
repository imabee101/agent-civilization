import type { Rng } from "./rng";

const ONSETS = ["", "b", "d", "f", "g", "h", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z", "sh", "th", "br", "kr", "tr"];
const NUCLEI = ["a", "e", "i", "o", "u", "ae", "ia", "io", "ou", "ei"];
const CODAS = ["", "n", "r", "s", "l", "th", "x", "sh", "m", "k"];

/** Deterministic pronounceable name, e.g. "Brasil", "Thoux". Pure flavor. */
export function generateName(rng: Rng): string {
  const syllables = 1 + rng.int(2);
  let s = "";
  for (let i = 0; i < syllables; i++) {
    s += rng.pick(ONSETS) + rng.pick(NUCLEI);
  }
  s += rng.pick(CODAS);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Sixteen visually distinct colors for agent markers. */
export const AGENT_COLORS = [
  "#ffcf6b",
  "#4fd1c5",
  "#ff8fa3",
  "#7ff3ff",
  "#c39bff",
  "#9be36b",
  "#ffa94d",
  "#6ba4ff",
  "#ff6bd6",
  "#d4f36b",
  "#6bffb8",
  "#ff6b6b",
  "#b8c9ff",
  "#ffe66b",
  "#6bd4ff",
  "#e0a3ff",
] as const;

export function colorForIndex(i: number): string {
  return AGENT_COLORS[((i % AGENT_COLORS.length) + AGENT_COLORS.length) % AGENT_COLORS.length]!;
}
