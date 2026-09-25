/**
 * Pure camera / hex-grid math. No DOM, no PixiJS — unit-testable.
 *
 * Hexes are pointy-top, addressed by axial (q, r) coordinates. The world is a
 * hexagon of tiles with radius R centred on (0, 0).
 */

export const SQRT3 = Math.sqrt(3);

export interface Point {
  x: number;
  y: number;
}

export interface Hex {
  q: number;
  r: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** Axial hex -> pixel centre, pointy-top orientation. `size` = circumradius. */
export function hexToPixel(q: number, r: number, size: number): Point {
  return {
    x: size * SQRT3 * (q + r / 2),
    y: size * 1.5 * r,
  };
}

/** Pixel -> fractional axial coordinates (not rounded). */
export function pixelToHexFrac(x: number, y: number, size: number): Hex {
  return {
    q: ((SQRT3 / 3) * x - (1 / 3) * y) / size,
    r: ((2 / 3) * y) / size,
  };
}

/** Round fractional axial coords to the nearest hex (cube rounding). */
export function hexRound(q: number, r: number): Hex {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  // normalise -0 so results compare cleanly
  return { q: rq === 0 ? 0 : rq, r: rr === 0 ? 0 : rr };
}

/** Pixel -> nearest axial hex. */
export function pixelToHex(x: number, y: number, size: number): Hex {
  const f = pixelToHexFrac(x, y, size);
  return hexRound(f.q, f.r);
}

/** Is (q, r) inside a hexagonal map of the given radius? */
export function inMap(q: number, r: number, radius: number): boolean {
  const s = -q - r;
  return Math.abs(q) <= radius && Math.abs(r) <= radius && Math.abs(s) <= radius;
}

/** Hex distance between two axial coordinates. */
export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
}

/** The six corners of a pointy-top hex centred at (cx, cy). */
export function hexCorners(cx: number, cy: number, size: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
  }
  return pts;
}

/**
 * Pixel bounding box (centred on 0,0) of a hexagonal map of tile radius
 * `radius`, including the outer half-tiles.
 */
export function worldBounds(radius: number, size: number): Bounds {
  // Widest row is r = 0: centres from q=-R..R => x = ±sqrt3*R*size, plus half a hex width each side.
  const halfW = SQRT3 * size * radius + (SQRT3 * size) / 2;
  // Tallest extent is r = ±R: y = ±1.5*R*size, plus one circumradius each side.
  const halfH = 1.5 * size * radius + size;
  return {
    minX: -halfW,
    maxX: halfW,
    minY: -halfH,
    maxY: halfH,
    width: halfW * 2,
    height: halfH * 2,
  };
}

/**
 * Zoom that fits a world of (worldW × worldH) into a viewport of
 * (viewportW × viewportH) with `padding` px on every side. Uses the smaller
 * of the two ratios so the whole world is visible in both portrait and
 * landscape — never letterboxed against a fixed aspect.
 */
export function fitZoom(
  viewportW: number,
  viewportH: number,
  worldW: number,
  worldH: number,
  padding = 0,
): number {
  const availW = Math.max(1, viewportW - padding * 2);
  const availH = Math.max(1, viewportH - padding * 2);
  const ww = Math.max(1e-6, worldW);
  const wh = Math.max(1e-6, worldH);
  const z = Math.min(availW / ww, availH / wh);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** Cover zoom: fills the viewport fully (world may overflow). */
export function coverZoom(viewportW: number, viewportH: number, worldW: number, worldH: number): number {
  const ww = Math.max(1e-6, worldW);
  const wh = Math.max(1e-6, worldH);
  const z = Math.max(viewportW / ww, viewportH / wh);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

export interface CameraState {
  /** World-space point shown at the centre of the viewport. */
  cx: number;
  cy: number;
  zoom: number;
}

/**
 * Compute a camera centred on the world with a zoom that fits it to the live
 * viewport dimensions.
 */
export function fitCamera(
  viewportW: number,
  viewportH: number,
  bounds: Bounds,
  padding = 0,
): CameraState {
  return {
    cx: (bounds.minX + bounds.maxX) / 2,
    cy: (bounds.minY + bounds.maxY) / 2,
    zoom: fitZoom(viewportW, viewportH, bounds.width, bounds.height, padding),
  };
}

/**
 * Camera centred on the world with the COVER zoom: the map fills the whole
 * viewport in both dimensions, so there is never empty space around it
 * (parts of the map may be off-screen; panning reveals them).
 */
export function coverCamera(viewportW: number, viewportH: number, bounds: Bounds): CameraState {
  return {
    cx: (bounds.minX + bounds.maxX) / 2,
    cy: (bounds.minY + bounds.maxY) / 2,
    zoom: coverZoom(viewportW, viewportH, bounds.width, bounds.height),
  };
}

/** Clamp a zoom between min/max factors relative to a reference zoom. */
export function clampZoom(zoom: number, fit: number, minFactor = 0.5, maxFactor = 8): number {
  return Math.min(fit * maxFactor, Math.max(fit * minFactor, zoom));
}

/**
 * Clamp the camera centre so the visible rectangle stays inside `bounds`.
 * If the viewport is larger than the world in a dimension (zoom below cover),
 * the world is centred in that dimension instead.
 */
export function clampCamera(cam: CameraState, bounds: Bounds, viewportW: number, viewportH: number): CameraState {
  const halfW = viewportW / cam.zoom / 2;
  const halfH = viewportH / cam.zoom / 2;
  const cx = halfW * 2 >= bounds.width ? (bounds.minX + bounds.maxX) / 2 : Math.min(bounds.maxX - halfW, Math.max(bounds.minX + halfW, cam.cx));
  const cy = halfH * 2 >= bounds.height ? (bounds.minY + bounds.maxY) / 2 : Math.min(bounds.maxY - halfH, Math.max(bounds.minY + halfH, cam.cy));
  return { cx, cy, zoom: cam.zoom };
}

/**
 * Fraction (0..1) of the viewport rectangle that lies inside the world
 * bounds for this camera. 1 means the map covers the whole screen.
 */
export function coverage(cam: CameraState, bounds: Bounds, viewportW: number, viewportH: number): number {
  const v = visibleWorldRect(cam, viewportW, viewportH);
  const area = v.width * v.height;
  if (!(area > 0) || !Number.isFinite(area)) return 0;
  const ix = Math.max(0, Math.min(v.maxX, bounds.maxX) - Math.max(v.minX, bounds.minX));
  const iy = Math.max(0, Math.min(v.maxY, bounds.maxY) - Math.max(v.minY, bounds.minY));
  return Math.max(0, Math.min(1, (ix * iy) / area));
}

/** World -> screen. */
export function worldToScreen(p: Point, cam: CameraState, viewportW: number, viewportH: number): Point {
  return {
    x: (p.x - cam.cx) * cam.zoom + viewportW / 2,
    y: (p.y - cam.cy) * cam.zoom + viewportH / 2,
  };
}

/** Screen -> world. */
export function screenToWorld(p: Point, cam: CameraState, viewportW: number, viewportH: number): Point {
  return {
    x: (p.x - viewportW / 2) / cam.zoom + cam.cx,
    y: (p.y - viewportH / 2) / cam.zoom + cam.cy,
  };
}

/**
 * Zoom about a screen point (wheel / pinch anchor): returns a new camera such
 * that the world point under `anchor` stays under `anchor`.
 */
export function zoomAt(
  cam: CameraState,
  newZoom: number,
  anchor: Point,
  viewportW: number,
  viewportH: number,
): CameraState {
  const before = screenToWorld(anchor, cam, viewportW, viewportH);
  const next: CameraState = { cx: cam.cx, cy: cam.cy, zoom: newZoom };
  const after = screenToWorld(anchor, next, viewportW, viewportH);
  return { cx: cam.cx + (before.x - after.x), cy: cam.cy + (before.y - after.y), zoom: newZoom };
}

/** The rectangle of world space currently visible. */
export function visibleWorldRect(cam: CameraState, viewportW: number, viewportH: number): Bounds {
  const w = viewportW / cam.zoom;
  const h = viewportH / cam.zoom;
  return {
    minX: cam.cx - w / 2,
    maxX: cam.cx + w / 2,
    minY: cam.cy - h / 2,
    maxY: cam.cy + h / 2,
    width: w,
    height: h,
  };
}
