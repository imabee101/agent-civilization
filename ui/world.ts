/**
 * PixiJS v8 renderer for the hex world. All camera math lives in lib/camera.ts.
 */
import { Application, Container, Graphics, Text, type TextStyleOptions } from "pixi.js";
import type { AgentView, RuinView, Season, StructureKind, TileView, WorldState, Phase } from "../src/shared/protocol";
import {
  hexToPixel,
  hexCorners,
  pixelToHex,
  worldBounds,
  coverCamera,
  clampCamera,
  clampZoom,
  coverage,
  inMap,
  zoomAt,
  screenToWorld,
  visibleWorldRect,
  type CameraState,
  type Bounds,
} from "./lib/camera";
import { tintForSeason } from "./lib/phase";
import { ITEM_GLYPH, STRUCTURE_COLOR, STRUCTURE_LABEL, indexTiles, mergeTiles, tileHasInterest, tileKey } from "./lib/structures";

export const HEX_SIZE = 24;
/** Zoom range relative to the cover zoom: never below cover (no void), up to 8x. */
export const MIN_ZOOM_FACTOR = 1;
export const MAX_ZOOM_FACTOR = 8;
const BACKDROP_FILL = 0x0c1520;
const BACKDROP_HEX = 0x10202f;
const BACKDROP_LINE = 0x172a3d;

export const TERRAIN_COLORS: Record<TileView["terrain"], number> = {
  grass: 0x3f7a4a,
  forest: 0x2b5a3a,
  water: 0x1f4f7a,
  rock: 0x59606e,
  sand: 0xa8925c,
};
const TERRAIN_EDGE: Record<TileView["terrain"], number> = {
  grass: 0x2c5a36,
  forest: 0x1e4229,
  water: 0x173c5e,
  rock: 0x3f454f,
  sand: 0x7d6b42,
};

function hexNum(c: string): number {
  const s = c.replace("#", "");
  const full = s.length === 3 ? s.split("").map((ch) => ch + ch).join("") : s;
  const n = parseInt(full, 16);
  return Number.isFinite(n) ? n : 0x8b93a5;
}

interface AgentSprite {
  root: Container;
  body: Graphics;
  ring: Graphics;
  label: Text;
  bubble: Container | null;
  bubbleText: Text | null;
  bubbleShownAt: number;
  bubbleTick: number;
  tx: number;
  ty: number;
  color: number;
  alive: boolean;
  thinking: boolean;
}

export interface WorldCallbacks {
  onSelect(agentId: string | null): void;
  /** A tile with a structure or items was tapped (and no agent stood there). */
  onSelectTile(key: string | null): void;
  onCameraChange(): void;
}

/** A structure or item marker drawn on a tile. */
interface TileMarker {
  key: string;
  root: Container;
  label: Text;
  x: number;
  y: number;
}

const LABEL_STYLE: TextStyleOptions = {
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 11,
  fontWeight: "600",
  fill: 0xe6e9ef,
  stroke: { color: 0x0a0d14, width: 3 },
};
const TILE_LABEL_STYLE: TextStyleOptions = {
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 9,
  fontWeight: "600",
  fill: 0xe6e9ef,
  stroke: { color: 0x0a0d14, width: 3 },
  letterSpacing: 0.6,
};
const ITEM_STYLE: TextStyleOptions = {
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 10,
  fontWeight: "700",
  fill: 0xffffff,
  stroke: { color: 0x0a0d14, width: 2 },
};
const BUBBLE_STYLE: TextStyleOptions = {
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 11,
  fill: 0x0a0d14,
  wordWrap: true,
  wordWrapWidth: 150,
  breakWords: true,
};

export class World {
  app = new Application();
  readonly host: HTMLElement;
  private world = new Container();
  private backdropG = new Graphics();
  private terrainG = new Graphics();
  private foodG = new Graphics();
  private structC = new Container();
  private springG = new Graphics();
  private itemsC = new Container();
  private tileSelG = new Graphics();
  private lineageG = new Graphics();
  private ruinsG = new Container();
  private agentsC = new Container();
  private overlay = new Graphics();
  private dim = new Graphics();
  private sprites = new Map<string, AgentSprite>();
  private markers = new Map<string, TileMarker>();
  private springs: { x: number; y: number }[] = [];
  private hoveredKey: string | null = null;
  private labelsForced = false;
  private ruinIds = "";
  tiles: TileView[] = [];
  tileIndex = new Map<string, number>();
  tileFood: number[] = [];
  selectedTile: string | null = null;
  mapRadius = 0;
  bounds: Bounds = worldBounds(0, HEX_SIZE);
  cam: CameraState = { cx: 0, cy: 0, zoom: 1 };
  private fitZoomValue = 1;
  private userMoved = false;
  private foodDirty = false;
  private lastFoodDraw = 0;
  private phase: Phase = "day";
  private dayProgress = 0.3;
  private season: Season = "spring";
  private state: WorldState | null = null;
  private cbs: WorldCallbacks;
  private pointers = new Map<number, { x: number; y: number }>();
  private dragStart: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private pinchStart: { dist: number; zoom: number; mid: { x: number; y: number } } | null = null;
  selectedId: string | null = null;
  private ready = false;

  constructor(host: HTMLElement, cbs: WorldCallbacks) {
    this.host = host;
    this.cbs = cbs;
  }

  async init(): Promise<void> {
    await this.app.init({
      resizeTo: window,
      background: 0x0a0d14,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      preference: "webgl",
    });
    this.host.appendChild(this.app.canvas);
    this.agentsC.sortableChildren = true;
    this.world.addChild(this.backdropG, this.terrainG, this.foodG, this.structC, this.springG, this.itemsC, this.tileSelG, this.ruinsG, this.lineageG, this.agentsC);
    this.app.stage.addChild(this.world, this.dim, this.overlay);
    this.app.renderer.on("resize", () => this.onResize());
    window.addEventListener("orientationchange", () => setTimeout(() => this.onResize(), 60));
    this.bindPointer();
    this.app.ticker.add(() => this.tick());
    this.ready = true;
    this.onResize();
  }

  get viewportW(): number {
    return window.innerWidth || this.app.screen.width;
  }
  get viewportH(): number {
    return window.innerHeight || this.app.screen.height;
  }

  /** Load a fresh map. */
  setMap(radius: number, tiles: TileView[]): void {
    this.mapRadius = radius;
    this.tiles = tiles;
    this.tileIndex = indexTiles(tiles);
    this.tileFood = tiles.map((t) => t.food);
    this.bounds = worldBounds(radius, HEX_SIZE);
    this.hoveredKey = null;
    this.drawBackdrop();
    this.drawTerrain();
    this.drawStructures();
    this.foodDirty = true;
    this.userMoved = false;
    this.fit();
  }

  /** Replace changed tiles in place (a `tiles` message) and redraw their markers. */
  updateTiles(incoming: readonly TileView[]): void {
    if (!incoming.length) return;
    const before = this.tiles.length;
    mergeTiles(this.tiles, this.tileIndex, incoming);
    if (this.tiles.length !== before) this.tileFood = this.tiles.map((t) => t.food);
    for (const t of incoming) {
      const i = this.tileIndex.get(tileKey(t.q, t.r));
      if (i !== undefined) this.tileFood[i] = t.food;
    }
    this.foodDirty = true;
    this.drawStructures();
    if (this.selectedTile) this.drawTileSelection();
  }

  tileAt(key: string): TileView | undefined {
    const i = this.tileIndex.get(key);
    return i === undefined ? undefined : this.tiles[i];
  }

  /**
   * Cover the live viewport with the world (max of both ratios): the map fills
   * the screen in every orientation, so there is never empty space around it.
   */
  fit(): void {
    const cam = coverCamera(this.viewportW, this.viewportH, this.bounds);
    this.fitZoomValue = cam.zoom;
    this.cam = clampCamera(cam, this.bounds, this.viewportW, this.viewportH);
    this.userMoved = false;
    this.applyCamera();
  }

  /** The cover zoom for the current viewport (the minimum zoom allowed). */
  get coverZoomValue(): number {
    return this.fitZoomValue;
  }

  /** Fraction of the viewport that lies inside the map's bounds (1 = fully covered). */
  coverage(): number {
    return coverage(this.cam, this.bounds, this.viewportW, this.viewportH);
  }

  /** Clamp zoom to [cover, cover*8] and keep the visible rect inside the map. */
  private constrain(cam: CameraState): CameraState {
    const zoom = clampZoom(cam.zoom, this.fitZoomValue, MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR);
    return clampCamera({ ...cam, zoom }, this.bounds, this.viewportW, this.viewportH);
  }

  private onResize(): void {
    if (!this.ready) return;
    const prevFit = this.fitZoomValue;
    const covered = coverCamera(this.viewportW, this.viewportH, this.bounds);
    this.fitZoomValue = covered.zoom;
    if (!this.userMoved) {
      this.cam = clampCamera(covered, this.bounds, this.viewportW, this.viewportH);
    } else {
      // keep the user's zoom relative to the cover zoom, never below it
      const factor = prevFit > 0 ? this.cam.zoom / prevFit : 1;
      this.cam = this.constrain({ cx: this.cam.cx, cy: this.cam.cy, zoom: covered.zoom * factor });
    }
    this.drawOverlay();
    this.applyCamera();
  }

  private applyCamera(): void {
    const { cx, cy, zoom } = this.cam;
    this.world.scale.set(zoom);
    this.world.position.set(this.viewportW / 2 - cx * zoom, this.viewportH / 2 - cy * zoom);
    for (const s of this.sprites.values()) this.counterScale(s);
    this.updateMarkerScale();
    this.cbs.onCameraChange();
  }

  centerOn(wx: number, wy: number): void {
    this.userMoved = true;
    this.cam = this.constrain({ ...this.cam, cx: wx, cy: wy });
    this.applyCamera();
  }

  /** Centre the camera on a hex, zooming in a little if the map is still at cover zoom. */
  centerOnHex(q: number, r: number): void {
    const p = hexToPixel(q, r, HEX_SIZE);
    const zoom = Math.max(this.cam.zoom, this.fitZoomValue * 2.4);
    this.userMoved = true;
    this.cam = this.constrain({ cx: p.x, cy: p.y, zoom });
    this.applyCamera();
  }

  visibleRect(): Bounds {
    return visibleWorldRect(this.cam, this.viewportW, this.viewportH);
  }

  // ---------- drawing ----------

  /**
   * Beyond the map edge: a dark-water tone with a faint ghost-hex grid, wide
   * enough to cover the map's bounding rectangle (and any transient margin
   * during a resize), so no part of the screen ever reads as dead space.
   */
  private drawBackdrop(): void {
    const g = this.backdropG;
    g.clear();
    const b = this.bounds;
    g.rect(b.minX - b.width * 2, b.minY - b.height * 2, b.width * 5, b.height * 5).fill({ color: BACKDROP_FILL });
    const R = this.mapRadius;
    const outer = R + Math.ceil(R * 1.5) + 3;
    for (let q = -outer; q <= outer; q++) {
      for (let r = -outer; r <= outer; r++) {
        if (!inMap(q, r, outer) || inMap(q, r, R)) continue;
        const c = hexToPixel(q, r, HEX_SIZE);
        g.poly(hexCorners(c.x, c.y, HEX_SIZE - 0.6).flatMap((p) => [p.x, p.y]));
        g.fill({ color: BACKDROP_HEX, alpha: 0.55 });
        g.stroke({ color: BACKDROP_LINE, width: 1, alpha: 0.5 });
      }
    }
  }

  private drawTerrain(): void {
    const g = this.terrainG;
    g.clear();
    for (const t of this.tiles) {
      const c = hexToPixel(t.q, t.r, HEX_SIZE);
      const pts = hexCorners(c.x, c.y, HEX_SIZE - 0.6);
      g.poly(pts.flatMap((p) => [p.x, p.y]));
      g.fill({ color: TERRAIN_COLORS[t.terrain] });
      g.stroke({ color: TERRAIN_EDGE[t.terrain], width: 1, alpha: 0.9 });
    }
  }

  private drawFood(): void {
    const g = this.foodG;
    g.clear();
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i]!;
      const food = this.tileFood[i] ?? 0;
      if (food <= 0 || t.terrain === "water") continue;
      const cap = Math.max(1, t.foodCap);
      const ratio = Math.min(1, food / cap);
      const c = hexToPixel(t.q, t.r, HEX_SIZE);
      // brightness wash proportional to food
      g.poly(hexCorners(c.x, c.y, HEX_SIZE - 3).flatMap((p) => [p.x, p.y]));
      g.fill({ color: 0xffe9a3, alpha: 0.05 + ratio * 0.14 });
      // dots: 1..3
      const dots = ratio > 0.66 ? 3 : ratio > 0.33 ? 2 : 1;
      for (let d = 0; d < dots; d++) {
        const ang = -Math.PI / 2 + (d * 2 * Math.PI) / 3;
        g.circle(c.x + Math.cos(ang) * 6, c.y + Math.sin(ang) * 6 + 2, 2.2);
        g.fill({ color: 0xffd97a, alpha: 0.55 + ratio * 0.45 });
      }
    }
  }

  // ---------- structures & items ----------

  private drawStructures(): void {
    for (const m of this.markers.values()) m.root.destroy({ children: true });
    this.markers.clear();
    this.itemsC.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.springs = [];
    for (const t of this.tiles) {
      if (!tileHasInterest(t)) continue;
      const key = tileKey(t.q, t.r);
      const c = hexToPixel(t.q, t.r, HEX_SIZE);
      const root = new Container();
      root.position.set(c.x, c.y);
      const g = new Graphics();
      root.addChild(g);
      let labelText = "";
      if (t.structure) {
        drawStructure(g, t.structure.kind, !!t.structure.locked);
        labelText = STRUCTURE_LABEL[t.structure.kind];
        if (t.structure.kind === "spring") this.springs.push({ x: c.x, y: c.y });
      }
      if (t.items && t.items.length) {
        const ig = new Graphics();
        const off = t.structure ? { x: HEX_SIZE * 0.42, y: HEX_SIZE * 0.36 } : { x: 0, y: 0 };
        drawItemCluster(ig, off.x, off.y);
        const glyph = new Text({ text: t.items.map((k) => ITEM_GLYPH[k]).join(""), style: ITEM_STYLE, resolution: 2 });
        glyph.anchor.set(0.5);
        glyph.position.set(off.x, off.y);
        const ic = new Container();
        ic.position.set(c.x, c.y);
        ic.addChild(ig, glyph);
        this.itemsC.addChild(ic);
        labelText = labelText ? `${labelText} · ${t.items.join(", ")}` : t.items.join(", ");
      }
      const label = new Text({ text: labelText, style: TILE_LABEL_STYLE, resolution: 2 });
      label.anchor.set(0.5, 0);
      label.position.set(0, HEX_SIZE * 0.5);
      label.visible = false;
      root.addChild(label);
      this.structC.addChild(root);
      this.markers.set(key, { key, root, label, x: c.x, y: c.y });
    }
    this.updateMarkerScale();
  }

  /** Labels keep screen size; they show on hover, when zoomed in, or for the selected tile. */
  private updateMarkerScale(): void {
    const k = Math.min(1 / Math.max(0.25, this.cam.zoom), 3.2);
    this.labelsForced = this.cam.zoom >= this.fitZoomValue * 2.2;
    for (const m of this.markers.values()) {
      m.label.scale.set(k);
      m.label.visible = this.labelsForced || m.key === this.hoveredKey || m.key === this.selectedTile;
    }
  }

  private setHovered(key: string | null): void {
    if (key === this.hoveredKey) return;
    const prev = this.hoveredKey ? this.markers.get(this.hoveredKey) : undefined;
    this.hoveredKey = key;
    if (prev) prev.label.visible = this.labelsForced || prev.key === this.selectedTile;
    const m = key ? this.markers.get(key) : undefined;
    if (m) m.label.visible = true;
    this.host.style.cursor = m ? "pointer" : "";
  }

  setSelectedTile(key: string | null): void {
    this.selectedTile = key;
    this.drawTileSelection();
    this.updateMarkerScale();
  }

  private drawTileSelection(): void {
    const g = this.tileSelG;
    g.clear();
    const t = this.selectedTile ? this.tileAt(this.selectedTile) : undefined;
    if (!t) return;
    const c = hexToPixel(t.q, t.r, HEX_SIZE);
    if (t.structure?.kind === "tower") {
      // faint ring: the tiles adjacent to the tower are where send() reaches farther
      g.circle(c.x, c.y, HEX_SIZE * 2.6).fill({ color: 0xe6e9ef, alpha: 0.06 });
      g.circle(c.x, c.y, HEX_SIZE * 2.6).stroke({ color: 0xe6e9ef, width: 1, alpha: 0.35 });
    }
    g.poly(hexCorners(c.x, c.y, HEX_SIZE - 1.2).flatMap((p) => [p.x, p.y]));
    g.stroke({ color: 0xffcf6b, width: 2.2, alpha: 0.95 });
  }

  private drawSprings(now: number): void {
    const g = this.springG;
    g.clear();
    if (!this.springs.length) return;
    for (const s of this.springs) {
      for (let i = 0; i < 2; i++) {
        const t = ((now / 1800) + i * 0.5) % 1;
        const r = HEX_SIZE * (0.25 + t * 0.55);
        g.circle(s.x, s.y, r).stroke({ color: 0x4fd1c5, width: 1.4, alpha: (1 - t) * 0.7 });
      }
    }
  }

  private drawOverlay(): void {
    const t = tintForSeason(this.phase, this.dayProgress, this.season);
    const w = this.viewportW;
    const h = this.viewportH;
    this.overlay.clear();
    this.overlay.rect(0, 0, w, h).fill({ color: hexNum(t.color), alpha: t.alpha });
    this.dim.clear();
    this.dim.rect(0, 0, w, h).fill({ color: 0x000000, alpha: (1 - t.brightness) * 0.75 });
  }

  setPhase(phase: Phase, dayProgress: number, season: Season = this.season): void {
    if (phase === this.phase && season === this.season && Math.abs(dayProgress - this.dayProgress) < 0.002) return;
    this.phase = phase;
    this.dayProgress = dayProgress;
    this.season = season;
    this.drawOverlay();
  }

  private counterScale(s: AgentSprite): void {
    const k = 1 / Math.max(0.25, this.cam.zoom);
    const clamped = Math.min(k, 3.2);
    s.label.scale.set(clamped);
    if (s.bubble) s.bubble.scale.set(clamped);
  }

  private makeSprite(a: AgentView): AgentSprite {
    const root = new Container();
    const ring = new Graphics();
    const body = new Graphics();
    const label = new Text({ text: a.name, style: LABEL_STYLE, resolution: 2 });
    label.anchor.set(0.5, 0);
    label.position.set(0, HEX_SIZE * 0.42);
    root.addChild(ring, body, label);
    this.agentsC.addChild(root);
    const p = hexToPixel(a.q, a.r, HEX_SIZE);
    root.position.set(p.x, p.y);
    const s: AgentSprite = {
      root,
      body,
      ring,
      label,
      bubble: null,
      bubbleText: null,
      bubbleShownAt: 0,
      bubbleTick: -1,
      tx: p.x,
      ty: p.y,
      color: hexNum(a.color),
      alive: a.alive,
      thinking: a.thinking,
    };
    this.drawBody(s, a);
    this.counterScale(s);
    return s;
  }

  private drawBody(s: AgentSprite, a: AgentView): void {
    const g = s.body;
    g.clear();
    const r = HEX_SIZE * 0.36;
    const selected = this.selectedId === a.id;
    if (a.alive) {
      g.circle(0, 0, r + 2).fill({ color: 0x0a0d14, alpha: 0.55 });
      g.circle(0, 0, r).fill({ color: s.color });
      g.circle(0, 0, r).stroke({ color: selected ? 0xffcf6b : 0xffffff, width: selected ? 2.5 : 1.2, alpha: selected ? 1 : 0.6 });
      // small health pip arc
      const hp = Math.max(0, Math.min(1, a.health / 100));
      if (hp < 1) {
        g.arc(0, 0, r + 4, -Math.PI / 2, -Math.PI / 2 + hp * Math.PI * 2);
        g.stroke({ color: hp < 0.35 ? 0xff5c5c : 0xffcf6b, width: 1.5, alpha: 0.9 });
      }
    } else {
      g.circle(0, 0, r).fill({ color: 0x59606e, alpha: 0.5 });
      g.circle(0, 0, r).stroke({ color: 0x8b93a5, width: 1, alpha: 0.5 });
    }
    s.label.alpha = a.alive ? 1 : 0.5;
  }

  private ensureBubble(s: AgentSprite, text: string): void {
    if (!s.bubble) {
      const c = new Container();
      const bg = new Graphics();
      const t = new Text({ text, style: BUBBLE_STYLE, resolution: 2 });
      c.addChild(bg, t);
      s.root.addChild(c);
      s.bubble = c;
      s.bubbleText = t;
    }
    const t = s.bubbleText!;
    t.text = text.length > 140 ? text.slice(0, 139) + "…" : text;
    const bg = s.bubble!.children[0] as Graphics;
    const pw = t.width + 14;
    const ph = t.height + 10;
    bg.clear();
    bg.roundRect(-pw / 2, -ph - 18, pw, ph, 7).fill({ color: 0xffffff, alpha: 0.94 });
    bg.poly([-5, -18, 5, -18, 0, -11]).fill({ color: 0xffffff, alpha: 0.94 });
    t.position.set(-pw / 2 + 7, -ph - 18 + 5);
    s.bubble!.alpha = 1;
    s.bubble!.visible = true;
    this.counterScale(s);
  }

  update(state: WorldState): void {
    this.state = state;
    this.setPhase(state.phase, state.dayProgress, state.season);
    const seen = new Set<string>();
    const now = performance.now();
    for (const a of state.agents) {
      seen.add(a.id);
      let s = this.sprites.get(a.id);
      if (!s) {
        s = this.makeSprite(a);
        this.sprites.set(a.id, s);
      }
      const p = hexToPixel(a.q, a.r, HEX_SIZE);
      s.tx = p.x;
      s.ty = p.y;
      s.color = hexNum(a.color);
      s.alive = a.alive;
      this.drawBody(s, a); // health arc / selection ring may change every tick
      s.thinking = a.thinking && a.alive;
      if (!s.thinking) s.ring.clear();
      if (s.label.text !== a.name) s.label.text = a.name;
      if (a.lastSaid && a.lastSaid.tick !== s.bubbleTick && a.alive) {
        s.bubbleTick = a.lastSaid.tick;
        s.bubbleShownAt = now;
        this.ensureBubble(s, a.lastSaid.text);
      }
      s.root.zIndex = a.alive ? 2 : 1;
    }
    for (const [id, s] of this.sprites) {
      if (!seen.has(id)) {
        s.root.destroy({ children: true });
        this.sprites.delete(id);
      }
    }
    this.updateRuins(state.ruins);
  }

  private updateRuins(ruins: RuinView[]): void {
    const key = ruins.map((r) => r.id).join(",");
    if (key === this.ruinIds) return;
    this.ruinIds = key;
    this.ruinsG.removeChildren().forEach((c) => c.destroy({ children: true }));
    for (const r of ruins) {
      if (this.sprites.has(r.id)) continue;
      const c = new Container();
      const g = new Graphics();
      const p = hexToPixel(r.q, r.r, HEX_SIZE);
      const rr = HEX_SIZE * 0.3;
      g.circle(0, 0, rr).fill({ color: 0x59606e, alpha: 0.45 });
      g.circle(0, 0, rr).stroke({ color: 0x8b93a5, width: 1, alpha: 0.55 });
      g.moveTo(-rr * 0.5, 0).lineTo(rr * 0.5, 0).moveTo(0, -rr * 0.6).lineTo(0, rr * 0.4).stroke({ color: 0x8b93a5, width: 1.2, alpha: 0.7 });
      const label = new Text({ text: r.name, style: { ...LABEL_STYLE, fill: 0x8b93a5 }, resolution: 2 });
      label.anchor.set(0.5, 0);
      label.position.set(0, HEX_SIZE * 0.4);
      label.scale.set(Math.min(1 / Math.max(0.25, this.cam.zoom), 3.2));
      c.addChild(g, label);
      c.position.set(p.x, p.y);
      c.alpha = 0.7;
      this.ruinsG.addChild(c);
    }
  }

  setTileFood(food: number[]): void {
    if (food.length === this.tileFood.length) {
      let changed = false;
      for (let i = 0; i < food.length; i++) {
        if (food[i] !== this.tileFood[i]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
    }
    this.tileFood = food;
    this.foodDirty = true;
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    if (this.state) for (const a of this.state.agents) {
      const s = this.sprites.get(a.id);
      if (s) this.drawBody(s, a);
    }
  }

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(0.1, this.app.ticker.deltaMS / 1000);
    this.drawSprings(now);
    if (this.foodDirty && now - this.lastFoodDraw > 200) {
      this.drawFood();
      this.foodDirty = false;
      this.lastFoodDraw = now;
    }
    for (const s of this.sprites.values()) {
      const k = 1 - Math.pow(0.001, dt);
      s.root.x += (s.tx - s.root.x) * k;
      s.root.y += (s.ty - s.root.y) * k;
      if (s.thinking) {
        const t = (now % 1400) / 1400;
        const r = HEX_SIZE * 0.42 + t * HEX_SIZE * 0.5;
        s.ring.clear();
        s.ring.circle(0, 0, r).stroke({ color: 0x7ff3ff, width: 2, alpha: (1 - t) * 0.9 });
        s.ring.circle(0, 0, HEX_SIZE * 0.42).stroke({ color: 0x7ff3ff, width: 1.5, alpha: 0.6 });
      }
      if (s.bubble && s.bubble.visible) {
        const age = (now - s.bubbleShownAt) / 1000;
        if (age > 6.5) s.bubble.visible = false;
        else if (age > 5) s.bubble.alpha = Math.max(0, 1 - (age - 5) / 1.5);
      }
    }
    this.drawLineage();
    // ruin labels keep screen size
    const ls = Math.min(1 / Math.max(0.25, this.cam.zoom), 3.2);
    for (const c of this.ruinsG.children) {
      const lbl = (c as Container).children[1];
      if (lbl && lbl.scale.x !== ls) lbl.scale.set(ls);
    }
  }

  /** Faint child→parent lines while the selected node is a parent or a child. */
  private drawLineage(): void {
    const g = this.lineageG;
    g.clear();
    const sel = this.selectedId;
    if (!sel || !this.state) return;
    const pos = (id: string): { x: number; y: number } | null => {
      const s = this.sprites.get(id);
      if (s) return { x: s.root.x, y: s.root.y };
      const r = this.state!.ruins.find((x) => x.id === id);
      return r ? hexToPixel(r.q, r.r, HEX_SIZE) : null;
    };
    const pairs: [string, string][] = [];
    for (const a of this.state.agents) {
      if (a.parentId && (a.id === sel || a.parentId === sel)) pairs.push([a.id, a.parentId]);
    }
    for (const [child, parent] of pairs) {
      const c = pos(child);
      const p = pos(parent);
      if (!c || !p) continue;
      g.moveTo(c.x, c.y).lineTo(p.x, p.y).stroke({ color: 0xffcf6b, width: 1.2, alpha: 0.35 });
      g.circle(p.x, p.y, HEX_SIZE * 0.5).stroke({ color: 0xffcf6b, width: 1, alpha: 0.25 });
    }
  }

  // ---------- pointer / camera interaction ----------

  private bindPointer(): void {
    const el = this.host;
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      this.setHovered(null);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.dragStart = { x: e.clientX, y: e.clientY, cx: this.cam.cx, cy: this.cam.cy, moved: false };
        this.pinchStart = null;
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchStart = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: this.cam.zoom, mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } };
        this.dragStart = null;
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.pointers.has(e.pointerId)) {
        if (e.pointerType === "mouse" && this.state) this.setHovered(this.hexKeyAt(e.clientX, e.clientY));
        return;
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2 && this.pinchStart) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
        const z = clampZoom((this.pinchStart.zoom * dist) / Math.max(1, this.pinchStart.dist), this.fitZoomValue, MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR);
        this.userMoved = true;
        this.cam = this.constrain(zoomAt(this.cam, z, mid, this.viewportW, this.viewportH));
        this.applyCamera();
        return;
      }
      if (this.dragStart && this.pointers.size === 1) {
        const dx = e.clientX - this.dragStart.x;
        const dy = e.clientY - this.dragStart.y;
        if (!this.dragStart.moved && Math.hypot(dx, dy) > 4) {
          this.dragStart.moved = true;
          el.classList.add("dragging");
        }
        if (this.dragStart.moved) {
          this.userMoved = true;
          this.cam = this.constrain({ ...this.cam, cx: this.dragStart.cx - dx / this.cam.zoom, cy: this.dragStart.cy - dy / this.cam.zoom });
          this.applyCamera();
        }
      }
    });
    const end = (e: PointerEvent) => {
      const wasTap = this.dragStart && !this.dragStart.moved && this.pointers.size === 1;
      this.pointers.delete(e.pointerId);
      if (wasTap) this.handleTap(e.clientX, e.clientY);
      if (this.pointers.size === 0) {
        this.dragStart = null;
        this.pinchStart = null;
        el.classList.remove("dragging");
      }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0015);
        const z = clampZoom(this.cam.zoom * factor, this.fitZoomValue, MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR);
        this.userMoved = true;
        this.cam = this.constrain(zoomAt(this.cam, z, { x: e.clientX, y: e.clientY }, this.viewportW, this.viewportH));
        this.applyCamera();
      },
      { passive: false },
    );
    el.addEventListener("dblclick", () => this.fit());
    el.addEventListener("pointerleave", () => this.setHovered(null));
  }

  /** Key of the interesting tile (structure / items) under a screen point, or null. */
  private hexKeyAt(sx: number, sy: number): string | null {
    const w = screenToWorld({ x: sx, y: sy }, this.cam, this.viewportW, this.viewportH);
    const h = pixelToHex(w.x, w.y, HEX_SIZE);
    const key = tileKey(h.q, h.r);
    return this.markers.has(key) ? key : null;
  }

  private handleTap(sx: number, sy: number): void {
    if (!this.state) return;
    const w = screenToWorld({ x: sx, y: sy }, this.cam, this.viewportW, this.viewportH);
    const hitR = Math.max(HEX_SIZE * 0.6, 14 / this.cam.zoom);
    let best: { id: string; d: number } | null = null;
    for (const a of this.state.agents) {
      const p = hexToPixel(a.q, a.r, HEX_SIZE);
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      if (d <= hitR && (!best || d < best.d)) best = { id: a.id, d };
    }
    if (best) {
      this.cbs.onSelect(best.id);
      return;
    }
    const key = this.hexKeyAt(sx, sy);
    if (key) this.cbs.onSelectTile(key);
    else this.cbs.onSelect(null);
  }
}

// ---------- marker drawing (pure PixiJS geometry, keyed on StructureKind) ----------

const INK = 0x0a0d14;

function drawStructure(g: Graphics, kind: StructureKind, locked: boolean): void {
  const col = STRUCTURE_COLOR[kind];
  const S = HEX_SIZE;
  switch (kind) {
    case "wall": {
      // solid dark hex: reads as impassable
      g.poly(hexCorners(0, 0, S - 1).flatMap((p) => [p.x, p.y])).fill({ color: col });
      g.poly(hexCorners(0, 0, S - 1).flatMap((p) => [p.x, p.y])).stroke({ color: 0x3a3f4a, width: 1.4, alpha: 0.9 });
      // mortar lines
      for (let y = -S * 0.5; y <= S * 0.5; y += S * 0.33) g.moveTo(-S * 0.55, y).lineTo(S * 0.55, y);
      g.stroke({ color: 0x2c3038, width: 1, alpha: 0.9 });
      break;
    }
    case "sign": {
      // small post with a plank
      g.moveTo(0, S * 0.35).lineTo(0, -S * 0.15).stroke({ color: 0x6b5232, width: 2.2 });
      g.roundRect(-S * 0.3, -S * 0.42, S * 0.6, S * 0.3, 2).fill({ color: col });
      g.roundRect(-S * 0.3, -S * 0.42, S * 0.6, S * 0.3, 2).stroke({ color: INK, width: 1, alpha: 0.8 });
      g.moveTo(-S * 0.2, -S * 0.27).lineTo(S * 0.2, -S * 0.27).stroke({ color: INK, width: 1, alpha: 0.6 });
      break;
    }
    case "board": {
      // rectangle on two legs with pinned notes
      g.moveTo(-S * 0.25, S * 0.4).lineTo(-S * 0.25, S * 0.05).moveTo(S * 0.25, S * 0.4).lineTo(S * 0.25, S * 0.05).stroke({ color: 0x6b5232, width: 2 });
      g.roundRect(-S * 0.42, -S * 0.42, S * 0.84, S * 0.5, 2).fill({ color: 0x2a2416 });
      g.roundRect(-S * 0.42, -S * 0.42, S * 0.84, S * 0.5, 2).stroke({ color: col, width: 1.4 });
      g.rect(-S * 0.32, -S * 0.32, S * 0.3, S * 0.13).fill({ color: col, alpha: 0.85 });
      g.rect(S * 0.05, -S * 0.32, S * 0.26, S * 0.13).fill({ color: 0xe6e9ef, alpha: 0.7 });
      g.rect(-S * 0.32, -S * 0.12, S * 0.5, S * 0.1).fill({ color: 0xe6e9ef, alpha: 0.5 });
      break;
    }
    case "cache": {
      // stacked folders
      for (let i = 2; i >= 0; i--) {
        const dx = -S * 0.36 + i * S * 0.07;
        const dy = -S * 0.2 - i * S * 0.12;
        g.roundRect(dx, dy, S * 0.66, S * 0.42, 2).fill({ color: i === 0 ? col : 0x2f8f9c });
        g.roundRect(dx, dy - S * 0.08, S * 0.26, S * 0.12, 1.5).fill({ color: i === 0 ? col : 0x2f8f9c });
        g.roundRect(dx, dy, S * 0.66, S * 0.42, 2).stroke({ color: INK, width: 1, alpha: 0.8 });
      }
      break;
    }
    case "plaque": {
      // stone tablet with engraved lines
      g.roundRect(-S * 0.3, -S * 0.4, S * 0.6, S * 0.74, 4).fill({ color: col });
      g.roundRect(-S * 0.3, -S * 0.4, S * 0.6, S * 0.74, 4).stroke({ color: INK, width: 1.2, alpha: 0.85 });
      for (let i = 0; i < 3; i++) g.moveTo(-S * 0.18, -S * 0.22 + i * S * 0.16).lineTo(S * 0.18, -S * 0.22 + i * S * 0.16);
      g.stroke({ color: INK, width: 1, alpha: 0.6 });
      break;
    }
    case "tower": {
      // tall triangle with a light on top
      g.poly([0, -S * 0.62, -S * 0.3, S * 0.4, S * 0.3, S * 0.4]).fill({ color: col });
      g.poly([0, -S * 0.62, -S * 0.3, S * 0.4, S * 0.3, S * 0.4]).stroke({ color: INK, width: 1.2, alpha: 0.85 });
      g.circle(0, -S * 0.62, S * 0.12).fill({ color: 0x7ff3ff });
      g.circle(0, -S * 0.62, S * 0.24).fill({ color: 0x7ff3ff, alpha: 0.25 });
      break;
    }
    case "vault": {
      // padlock; dimmed while locked
      const a = locked ? 0.55 : 1;
      g.roundRect(-S * 0.32, -S * 0.05, S * 0.64, S * 0.46, 3).fill({ color: col, alpha: a });
      g.roundRect(-S * 0.32, -S * 0.05, S * 0.64, S * 0.46, 3).stroke({ color: INK, width: 1.2, alpha: 0.85 * a });
      const cx = locked ? 0 : S * 0.16;
      g.arc(cx, -S * 0.08, S * 0.2, Math.PI, 0).stroke({ color: locked ? col : 0xe6e9ef, width: 2.4, alpha: a });
      g.circle(0, S * 0.16, S * 0.07).fill({ color: INK, alpha: 0.9 * a });
      break;
    }
    case "spring": {
      // teal pool with a soft glow (ripples are animated separately)
      g.circle(0, 0, S * 0.62).fill({ color: col, alpha: 0.18 });
      g.circle(0, 0, S * 0.36).fill({ color: 0x1f4f7a, alpha: 0.9 });
      g.circle(0, 0, S * 0.36).stroke({ color: col, width: 1.4, alpha: 0.9 });
      g.circle(-S * 0.1, -S * 0.1, S * 0.08).fill({ color: 0xbffcf5, alpha: 0.8 });
      break;
    }
  }
}

function drawItemCluster(g: Graphics, x: number, y: number): void {
  const S = HEX_SIZE;
  g.circle(x, y, S * 0.36).fill({ color: 0xffffff, alpha: 0.1 });
  g.circle(x, y, S * 0.36).stroke({ color: 0xffffff, width: 1, alpha: 0.35 });
  for (let i = 0; i < 3; i++) {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
    g.circle(x + Math.cos(ang) * S * 0.36, y + Math.sin(ang) * S * 0.36, 1.6).fill({ color: 0xffffff, alpha: 0.9 });
  }
}
