import { describe, expect, test } from "bun:test";
import type { Phase } from "../../src/shared/protocol";
import type { Season } from "../../src/shared/protocol";
import { tintFor, tintForSeason, seasonTint, phaseProgress, sunElevation, rgbToHex, PHASE_WINDOWS } from "../../ui/lib/phase";

const PHASES: Phase[] = ["dawn", "day", "dusk", "night"];
const SEASONS: Season[] = ["spring", "summer", "autumn", "winter"];

describe("seasonTint / tintForSeason", () => {
  test("every season has a valid, subtle cast", () => {
    for (const s of SEASONS) {
      const t = seasonTint(s);
      expect(t.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(t.alpha).toBeGreaterThan(0);
      expect(t.alpha).toBeLessThanOrEqual(0.1);
      expect(t.brightness).toBeGreaterThan(0.9);
      expect(t.brightness).toBeLessThanOrEqual(1.05);
    }
    expect(seasonTint("nope" as Season)).toEqual(seasonTint("spring"));
  });
  test("winter cools and dims, autumn warms", () => {
    const w = seasonTint("winter");
    const a = seasonTint("autumn");
    const wr = parseInt(w.color.slice(1, 3), 16), wb = parseInt(w.color.slice(5, 7), 16);
    const ar = parseInt(a.color.slice(1, 3), 16), ab = parseInt(a.color.slice(5, 7), 16);
    expect(wb).toBeGreaterThan(wr);
    expect(ar).toBeGreaterThan(ab);
    expect(w.brightness).toBeLessThan(seasonTint("summer").brightness);
  });
  test("combined tint stays bounded and only nudges the day/night tint", () => {
    for (const phase of PHASES) {
      for (const s of SEASONS) {
        for (let p = 0; p <= 1.0001; p += 0.1) {
          const base = tintFor(phase, p);
          const t = tintForSeason(phase, p, s);
          expect(t.color).toMatch(/^#[0-9a-f]{6}$/);
          expect(t.alpha).toBeGreaterThanOrEqual(base.alpha);
          expect(t.alpha).toBeLessThanOrEqual(0.7);
          expect(Math.abs(t.brightness - base.brightness)).toBeLessThan(0.08);
          expect(t.brightness).toBeGreaterThan(0.4);
        }
      }
    }
    // winter nights are darker than summer nights; day tint is barely changed by season
    expect(tintForSeason("night", 0.87, "winter").brightness).toBeLessThan(tintForSeason("night", 0.87, "summer").brightness);
    expect(tintForSeason("day", 0.4, "winter").alpha).toBeLessThan(0.15);
  });
});

describe("tintFor", () => {
  test("returns valid hex colour and bounded alpha/brightness for every phase and progress", () => {
    for (const phase of PHASES) {
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const t = tintFor(phase, p);
        expect(t.color).toMatch(/^#[0-9a-f]{6}$/);
        expect(t.alpha).toBeGreaterThanOrEqual(0);
        expect(t.alpha).toBeLessThanOrEqual(0.7);
        expect(t.brightness).toBeGreaterThan(0.4);
        expect(t.brightness).toBeLessThanOrEqual(1);
      }
    }
  });
  test("night is darker than day", () => {
    const night = tintFor("night", 0.87);
    const day = tintFor("day", 0.4);
    expect(night.alpha).toBeGreaterThan(day.alpha);
    expect(night.brightness).toBeLessThan(day.brightness);
    expect(day.alpha).toBeLessThan(0.1);
  });
  test("dawn brightens over its window, dusk darkens", () => {
    const [a, b] = PHASE_WINDOWS.dawn;
    expect(tintFor("dawn", a).brightness).toBeLessThan(tintFor("dawn", b).brightness);
    expect(tintFor("dawn", a).alpha).toBeGreaterThan(tintFor("dawn", b).alpha);
    const [c, d] = PHASE_WINDOWS.dusk;
    expect(tintFor("dusk", c).alpha).toBeLessThan(tintFor("dusk", d).alpha);
    expect(tintFor("dusk", c).brightness).toBeGreaterThan(tintFor("dusk", d).brightness);
  });
  test("phase transitions are continuous at the boundaries", () => {
    const endDawn = tintFor("dawn", PHASE_WINDOWS.dawn[1]);
    const startDay = tintFor("day", PHASE_WINDOWS.day[0]);
    expect(Math.abs(endDawn.alpha - startDay.alpha)).toBeLessThan(0.05);
    const endDusk = tintFor("dusk", PHASE_WINDOWS.dusk[1]);
    const startNight = tintFor("night", PHASE_WINDOWS.night[0]);
    expect(Math.abs(endDusk.alpha - startNight.alpha)).toBeLessThan(0.05);
  });
  test("handles out-of-range / NaN progress", () => {
    expect(tintFor("day", -3).alpha).toBeGreaterThanOrEqual(0);
    expect(tintFor("night", NaN).color).toMatch(/^#[0-9a-f]{6}$/);
    expect(phaseProgress("dawn", 2)).toBe(1);
    expect(phaseProgress("dawn", -2)).toBe(0);
  });
});

describe("sunElevation / rgbToHex", () => {
  test("sun is below horizon at night and highest mid-day", () => {
    expect(sunElevation("night", 0.9)).toBe(0);
    const mid = sunElevation("day", (PHASE_WINDOWS.dawn[0] + PHASE_WINDOWS.dusk[1]) / 2);
    expect(mid).toBeCloseTo(1, 5);
    expect(sunElevation("dawn", 0.02)).toBeLessThan(mid);
  });
  test("rgbToHex", () => {
    expect(rgbToHex({ r: 255, g: 0, b: 16 })).toBe("#ff0010");
    expect(rgbToHex({ r: -5, g: 300, b: 0 })).toBe("#00ff00");
  });
});
