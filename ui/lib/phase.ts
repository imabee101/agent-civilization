/**
 * Day/night tint. Pure: (phase, dayProgress) -> { color, alpha, brightness }.
 * The overlay colour is drawn over the whole screen with the given alpha;
 * `brightness` (0..1) can additionally dim the world layer.
 */
import type { Phase, Season } from "../../src/shared/protocol";

export interface Tint {
  /** Hex colour string, e.g. "#0b1030". */
  color: string;
  /** 0..1 overlay alpha. */
  alpha: number;
  /** 0..1 multiplier for world brightness (1 = full). */
  brightness: number;
}

/** Nominal window of each phase within a day, as fractions of dayProgress. */
export const PHASE_WINDOWS: Record<Phase, [number, number]> = {
  dawn: [0, 0.15],
  day: [0.15, 0.6],
  dusk: [0.6, 0.75],
  night: [0.75, 1],
};

const NIGHT = { r: 10, g: 16, b: 48 };
const DAWN = { r: 255, g: 154, b: 90 };
const DUSK = { r: 255, g: 106, b: 61 };
const DAY = { r: 255, g: 240, b: 200 };

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number) {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

export function rgbToHex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.round(clamp01(v / 255) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** Progress (0..1) through the given phase, derived from the whole-day progress. */
export function phaseProgress(phase: Phase, dayProgress: number): number {
  const [a, b] = PHASE_WINDOWS[phase];
  const p = clamp01(Number.isFinite(dayProgress) ? dayProgress : 0);
  if (b <= a) return 0;
  return clamp01((p - a) / (b - a));
}

/** Smoothstep. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

export function tintFor(phase: Phase, dayProgress: number): Tint {
  const t = phaseProgress(phase, dayProgress);
  switch (phase) {
    case "dawn": {
      // night -> warm orange -> almost clear
      const k = ease(t);
      const color = k < 0.5 ? mix(NIGHT, DAWN, k * 2) : mix(DAWN, DAY, (k - 0.5) * 2);
      const alpha = k < 0.5 ? lerp(0.5, 0.22, k * 2) : lerp(0.22, 0.04, (k - 0.5) * 2);
      return { color: rgbToHex(color), alpha, brightness: lerp(0.62, 1, k) };
    }
    case "day": {
      return { color: rgbToHex(DAY), alpha: 0.03, brightness: 1 };
    }
    case "dusk": {
      const k = ease(t);
      const color = k < 0.5 ? mix(DAY, DUSK, k * 2) : mix(DUSK, NIGHT, (k - 0.5) * 2);
      const alpha = k < 0.5 ? lerp(0.04, 0.24, k * 2) : lerp(0.24, 0.5, (k - 0.5) * 2);
      return { color: rgbToHex(color), alpha, brightness: lerp(1, 0.62, k) };
    }
    case "night":
    default: {
      // deepest in the middle of the night
      const depth = 1 - Math.abs(t - 0.5) * 2;
      return { color: rgbToHex(NIGHT), alpha: lerp(0.5, 0.58, depth), brightness: lerp(0.62, 0.55, depth) };
    }
  }
}

/** Subtle seasonal cast layered under the day/night tint. */
export interface SeasonTint {
  /** Hex colour of the seasonal wash. */
  color: string;
  /** 0..1 alpha of the wash (kept small: a cast, not a filter). */
  alpha: number;
  /** Multiplier on the day/night brightness (winter a little dimmer, summer a touch brighter). */
  brightness: number;
}

const SEASON_TINTS: Record<Season, SeasonTint> = {
  spring: { color: "#a8ff9c", alpha: 0.035, brightness: 1 },
  summer: { color: "#ffe28a", alpha: 0.04, brightness: 1.03 },
  autumn: { color: "#ff9a4a", alpha: 0.06, brightness: 0.98 },
  winter: { color: "#9ec4ff", alpha: 0.08, brightness: 0.94 },
};

/** Pure: the seasonal cast for a season. Unknown input falls back to spring (neutral). */
export function seasonTint(season: Season): SeasonTint {
  return SEASON_TINTS[season] ?? SEASON_TINTS.spring;
}

/** Day/night tint combined with the seasonal cast: colour mixed by alpha weight, brightness multiplied. */
export function tintForSeason(phase: Phase, dayProgress: number, season: Season): Tint {
  const base = tintFor(phase, dayProgress);
  const s = seasonTint(season);
  const wSum = base.alpha + s.alpha;
  const k = wSum > 0 ? s.alpha / wSum : 0;
  const color = rgbToHex(mix(hexToRgb(base.color), hexToRgb(s.color), k));
  return { color, alpha: clamp01(base.alpha + s.alpha * (1 - base.alpha)), brightness: clamp01(base.brightness * s.brightness) };
}

function hexToRgb(h: string): { r: number; g: number; b: number } {
  const n = parseInt(h.replace("#", ""), 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Sun elevation 0..1 (0 = horizon/below, 1 = zenith) for the sun-arc clock. */
export function sunElevation(phase: Phase, dayProgress: number): number {
  const p = clamp01(dayProgress);
  const rise = PHASE_WINDOWS.dawn[0];
  const set = PHASE_WINDOWS.dusk[1];
  if (phase === "night") return 0;
  const x = clamp01((p - rise) / (set - rise));
  return Math.sin(x * Math.PI);
}
