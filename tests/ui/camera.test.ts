import { describe, expect, test } from "bun:test";
import {
  fitZoom,
  fitCamera,
  hexToPixel,
  pixelToHex,
  hexRound,
  worldBounds,
  inMap,
  hexDistance,
  hexCorners,
  zoomAt,
  screenToWorld,
  worldToScreen,
  clampZoom,
  visibleWorldRect,
  SQRT3,
} from "../../ui/lib/camera";

describe("fitZoom", () => {
  test("landscape viewport, landscape world: limited by height", () => {
    // world 1000x500, viewport 1440x900 => min(1.44, 1.8) = 1.44
    expect(fitZoom(1440, 900, 1000, 500)).toBeCloseTo(1.44, 5);
  });
  test("portrait viewport, wider world: limited by width (no letterboxing to landscape)", () => {
    // world 1000x800, viewport 390x844 => min(0.39, 1.055) = 0.39
    expect(fitZoom(390, 844, 1000, 800)).toBeCloseTo(0.39, 5);
  });
  test("landscape phone, same world: limited by height", () => {
    expect(fitZoom(844, 390, 1000, 800)).toBeCloseTo(390 / 800, 5);
  });
  test("padding reduces available viewport", () => {
    expect(fitZoom(1000, 1000, 100, 100, 100)).toBeCloseTo(8, 5);
  });
  test("always uses the smaller ratio", () => {
    for (const [vw, vh, ww, wh] of [
      [390, 844, 700, 700],
      [844, 390, 700, 700],
      [1440, 900, 700, 700],
      [1024, 1366, 1200, 300],
    ] as const) {
      const z = fitZoom(vw, vh, ww, wh);
      expect(z).toBeCloseTo(Math.min(vw / ww, vh / wh), 8);
      expect(ww * z).toBeLessThanOrEqual(vw + 1e-6);
      expect(wh * z).toBeLessThanOrEqual(vh + 1e-6);
    }
  });
  test("degenerate inputs do not produce NaN/Infinity/0", () => {
    expect(fitZoom(0, 0, 0, 0)).toBeGreaterThan(0);
    expect(Number.isFinite(fitZoom(100, 100, 0, 0))).toBe(true);
    expect(fitZoom(100, 100, NaN, 100)).toBeGreaterThan(0);
  });
  test("fitCamera centres on world bounds", () => {
    const b = worldBounds(10, 20);
    const cam = fitCamera(390, 844, b, 8);
    expect(cam.cx).toBeCloseTo(0, 8);
    expect(cam.cy).toBeCloseTo(0, 8);
    expect(cam.zoom).toBeCloseTo(fitZoom(390, 844, b.width, b.height, 8), 8);
    // fitted world must fit inside the viewport in portrait
    expect(b.width * cam.zoom).toBeLessThanOrEqual(390);
    expect(b.height * cam.zoom).toBeLessThanOrEqual(844);
  });
});

describe("hex math", () => {
  test("hexToPixel origin and neighbours (pointy-top)", () => {
    const s = 10;
    expect(hexToPixel(0, 0, s)).toEqual({ x: 0, y: 0 });
    const e = hexToPixel(1, 0, s);
    expect(e.x).toBeCloseTo(SQRT3 * s, 8);
    expect(e.y).toBeCloseTo(0, 8);
    const se = hexToPixel(0, 1, s);
    expect(se.x).toBeCloseTo((SQRT3 * s) / 2, 8);
    expect(se.y).toBeCloseTo(1.5 * s, 8);
  });
  test("round-trips every hex in a radius-12 map at several sizes", () => {
    for (const size of [7, 16, 24.5]) {
      for (let q = -12; q <= 12; q++) {
        for (let r = -12; r <= 12; r++) {
          if (!inMap(q, r, 12)) continue;
          const p = hexToPixel(q, r, size);
          expect(pixelToHex(p.x, p.y, size)).toEqual({ q, r });
          // slightly off-centre points still round to the same hex
          expect(pixelToHex(p.x + size * 0.3, p.y - size * 0.3, size)).toEqual({ q, r });
        }
      }
    }
  });
  test("hexRound preserves q+r+s=0", () => {
    const h = hexRound(0.4, 0.4);
    expect(Number.isInteger(h.q)).toBe(true);
    expect(Number.isInteger(h.r)).toBe(true);
    expect(hexRound(0, 0)).toEqual({ q: 0, r: 0 });
  });
  test("inMap / hexDistance", () => {
    expect(inMap(3, -3, 3)).toBe(true);
    expect(inMap(3, 1, 3)).toBe(false);
    expect(inMap(0, 0, 0)).toBe(true);
    expect(hexDistance({ q: 0, r: 0 }, { q: 3, r: -3 })).toBe(3);
    expect(hexDistance({ q: 0, r: 0 }, { q: 2, r: 2 })).toBe(4);
  });
  test("hexCorners gives six points on the circumcircle", () => {
    const c = hexCorners(5, 5, 10);
    expect(c).toHaveLength(6);
    for (const p of c) expect(Math.hypot(p.x - 5, p.y - 5)).toBeCloseTo(10, 8);
    // pointy-top: a corner at the very top
    expect(Math.min(...c.map((p) => p.y))).toBeCloseTo(-5, 8);
  });
  test("worldBounds contains every tile of the map and is symmetric", () => {
    const R = 10;
    const size = 20;
    const b = worldBounds(R, size);
    expect(b.minX).toBeCloseTo(-b.maxX, 8);
    expect(b.minY).toBeCloseTo(-b.maxY, 8);
    expect(b.width).toBeCloseTo(SQRT3 * size * (2 * R + 1), 8);
    expect(b.height).toBeCloseTo(size * (3 * R + 2), 8);
    for (let q = -R; q <= R; q++) {
      for (let r = -R; r <= R; r++) {
        if (!inMap(q, r, R)) continue;
        for (const c of hexCorners(hexToPixel(q, r, size).x, hexToPixel(q, r, size).y, size)) {
          expect(c.x).toBeGreaterThanOrEqual(b.minX - 1e-6);
          expect(c.x).toBeLessThanOrEqual(b.maxX + 1e-6);
          expect(c.y).toBeGreaterThanOrEqual(b.minY - 1e-6);
          expect(c.y).toBeLessThanOrEqual(b.maxY + 1e-6);
        }
      }
    }
  });
});

describe("camera transforms", () => {
  test("world<->screen round trip", () => {
    const cam = { cx: 12, cy: -40, zoom: 1.7 };
    const p = { x: 300, y: 200 };
    const w = screenToWorld(p, cam, 800, 600);
    const back = worldToScreen(w, cam, 800, 600);
    expect(back.x).toBeCloseTo(p.x, 8);
    expect(back.y).toBeCloseTo(p.y, 8);
  });
  test("zoomAt keeps the anchor fixed", () => {
    const cam = { cx: 0, cy: 0, zoom: 1 };
    const anchor = { x: 100, y: 500 };
    const before = screenToWorld(anchor, cam, 390, 844);
    const next = zoomAt(cam, 2.5, anchor, 390, 844);
    const after = screenToWorld(anchor, next, 390, 844);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
    expect(next.zoom).toBe(2.5);
  });
  test("clampZoom bounds relative to fit", () => {
    expect(clampZoom(100, 1)).toBe(8);
    expect(clampZoom(0.01, 1)).toBe(0.5);
    expect(clampZoom(2, 1)).toBe(2);
  });
  test("visibleWorldRect scales with zoom", () => {
    const r = visibleWorldRect({ cx: 0, cy: 0, zoom: 2 }, 800, 400);
    expect(r.width).toBe(400);
    expect(r.height).toBe(200);
    expect(r.minX).toBe(-200);
  });
});
