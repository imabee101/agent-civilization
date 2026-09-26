/**
 * PixiJS v8 renderer for the hex world. All camera math lives in lib/camera.ts.
 */
import { Application, Container, Graphics, Text, type TextStyleOptions } from "pixi.js";
import type { AgentView, RuinView, Season, StructureKind, TileView, WorldEvent, WorldState, Phase } from "../src/shared/protocol";
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
import { TERRAIN_COLORS, TERRAIN_EDGE, foodShade, tileFill } from "./lib/terrain";
import { LABEL_PRIORITY, visibleLabels, type LabelBox } from "./lib/labels";
import {
  ARC_MS,
  GLYPH_MS,
  HUNGER_COLOR,
  MAX_EFFECTS,
  arcControl,
  fadeAlpha,
  hungerFraction,
  hungerLevel,
  planEffects,
  quadPoint,
  type GlyphKind,
} from "./lib/effects";

export { TERRAIN_COLORS };

export const HEX_SIZE = 24;
const INK = 0x0a0d14;
/** Node body radius, hunger-ring radius and thinking-ring radius (world units). */
const NODE_R = HEX_SIZE * 0.36;
const HUNGER_R = NODE_R + 3.4;
const THINK_R = HUNGER_R + 6;
/** Name label offset below the node centre, clear of the hunger and health rings. */
const LABEL_DY = HUNGER_R + 5;
/** Action-glyph badge radius in screen pixels. */
const GLYPH_R = 8;
const MESSAGE_COLOR = 0x9fd8ff;
/** Zoom range relative to the cover zoom: never below cover (no void), up to 8x. */
export const MIN_ZOOM_FACTOR = 1;
export const MAX_ZOOM_FACTOR = 8;
const BACKDROP_FILL = 0x0c1520;
const BACKDROP_HEX = 0x10202f;
const BACKDROP_LINE = 0x172a3d;


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
  /** Red halo pulsed while the node is starving (food 0). */
  pulse: Graphics;
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
  starving: boolean;
  /** False while the name label would collide with a higher-priority label. */
  labelShown: boolean;
}

/** A pooled action glyph: a small badge beside a node, reused across events. */
interface GlyphFx {
  root: Container;
  g: Graphics;
  agentId: string;
  born: number;
  active: boolean;
}

/** A message arc between two nodes, redrawn each frame into one shared Graphics. */
interface ArcFx {
  from: string;
  to: string;
  born: number;
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
  fontFamily: "IBM Plex Sans, system-ui, sans-serif",
  fontSize: 11,
  fontWeight: "600",
  fill: 0xe6e9ef,
  stroke: { color: 0x0a0d14, width: 3 },
};
const TILE_LABEL_STYLE: TextStyleOptions = {
  fontFamily: "IBM Plex Sans, system-ui, sans-serif",
  fontSize: 9,
  fontWeight: "600",
  fill: 0xe6e9ef,
  stroke: { color: 0x0a0d14, width: 3 },
  letterSpacing: 0.6,
};
const ITEM_STYLE: TextStyleOptions = {
  fontFamily: "IBM Plex Sans, system-ui, sans-serif",
  fontSize: 10,
  fontWeight: "700",
  fill: 0xffffff,
  stroke: { color: 0x0a0d14, width: 2 },
};
const BUBBLE_STYLE: TextStyleOptions = {
  fontFamily: "IBM Plex Sans, system-ui, sans-serif",
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
  private structC = new Container();
  private springG = new Graphics();
  private itemsC = new Container();
  private tileSelG = new Graphics();
  private lineageG = new Graphics();
  private arcG = new Graphics();
  private glyphC = new Container();
  /** Name labels and speech bubbles live above every node so a neighbour never covers them. */
  private labelsC = new Container();
  private bubblesC = new Container();
  private glyphs: GlyphFx[] = [];
  private arcs: ArcFx[] = [];
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
  private lastDeclutter = 0;
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
    this.world.addChild(this.backdropG, this.terrainG, this.structC, this.springG, this.itemsC, this.tileSelG, this.ruinsG, this.lineageG, this.arcG, this.agentsC, this.labelsC, this.glyphC, this.bubblesC);
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
    this.foodDirty = false;
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

  /** Tiles, with food shown as shading within each terrain's colour. Redrawn only when food changes. */
  private drawTerrain(): void {
    const g = this.terrainG;
    g.clear();
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i]!;
      const c = hexToPixel(t.q, t.r, HEX_SIZE);
      const pts = hexCorners(c.x, c.y, HEX_SIZE - 0.6);
      g.poly(pts.flatMap((p) => [p.x, p.y]));
      g.fill({ color: tileFill(t.terrain, this.tileFood[i] ?? t.food, t.foodCap) });
      g.stroke({ color: TERRAIN_EDGE[t.terrain], width: 1, alpha: 0.9 });
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
    const pulse = new Graphics();
    pulse.circle(0, 0, HUNGER_R).stroke({ color: HUNGER_COLOR.starving, width: 3 });
    pulse.visible = false;
    const body = new Graphics();
    const label = new Text({ text: a.name, style: LABEL_STYLE, resolution: 2 });
    label.anchor.set(0.5, 0);
    root.addChild(ring, pulse, body);
    this.agentsC.addChild(root);
    this.labelsC.addChild(label);
    const p = hexToPixel(a.q, a.r, HEX_SIZE);
    root.position.set(p.x, p.y);
    label.position.set(p.x, p.y + LABEL_DY);
    const s: AgentSprite = {
      root,
      body,
      ring,
      pulse,
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
      starving: false,
      labelShown: true,
    };
    this.drawBody(s, a);
    this.counterScale(s);
    return s;
  }

  /** A wash shared by every living node on the same loop. One node alone stays unmarked. */
  private kinColor(a: AgentView): number | null {
    if (!a.alive || !a.codeKey || !this.state) return null;
    const n = this.state.agents.filter((x) => x.alive && x.codeKey === a.codeKey).length;
    if (n < 2) return null;
    const palette = [0x4fd1c5, 0xffcf6b, 0xf0a070, 0x9aa7ff, 0xe89bb8, 0xb7d98a];
    return palette[parseInt(a.codeKey.slice(0, 2), 16) % palette.length] ?? palette[0]!;
  }

  private drawBody(s: AgentSprite, a: AgentView): void {
    const g = s.body;
    g.clear();
    const r = NODE_R;
    const selected = this.selectedId === a.id;
    if (a.alive) {
      g.circle(0, 0, r + 2).fill({ color: 0x0a0d14, alpha: 0.55 });
      g.circle(0, 0, r).fill({ color: s.color });
      g.circle(0, 0, r).stroke({ color: selected ? 0xffcf6b : 0xffffff, width: selected ? 2.5 : 1.2, alpha: selected ? 1 : 0.6 });
      const kin = this.kinColor(a);
      if (kin !== null) g.circle(0, 0, r + 6).stroke({ color: kin, width: 2, alpha: 0.9 });
      if (a.lastError) g.circle(r * 0.7, -r * 0.7, 3.2).fill({ color: 0xff5c5c });
      // hunger ring: dark track, then food 0..100 clockwise from the top
      const level = hungerLevel(a.food);
      const fed = hungerFraction(a.food);
      g.circle(0, 0, HUNGER_R).stroke({ color: INK, width: 3.6, alpha: 0.7 });
      if (fed > 0) {
        g.moveTo(0, -HUNGER_R).arc(0, 0, HUNGER_R, -Math.PI / 2, -Math.PI / 2 + fed * Math.PI * 2);
        g.stroke({ color: HUNGER_COLOR[level], width: 2.2, alpha: 1, cap: "round" });
      }
      // thin health arc just outside, only once hurt
      const hp = Math.max(0, Math.min(1, a.health / 100));
      if (hp < 1) {
        g.moveTo(0, -(HUNGER_R + 3.4)).arc(0, 0, HUNGER_R + 3.4, -Math.PI / 2, -Math.PI / 2 + hp * Math.PI * 2);
        g.stroke({ color: hp < 0.35 ? 0xff5c5c : 0xe6e9ef, width: 1.2, alpha: 0.8 });
      }
    } else {
      g.circle(0, 0, r).fill({ color: 0x59606e, alpha: 0.5 });
      g.circle(0, 0, r).stroke({ color: 0x8b93a5, width: 1, alpha: 0.5 });
    }
  }

  private ensureBubble(s: AgentSprite, text: string): void {
    if (!s.bubble) {
      const c = new Container();
      const bg = new Graphics();
      const t = new Text({ text, style: BUBBLE_STYLE, resolution: 2 });
      c.addChild(bg, t);
      c.position.set(s.root.x, s.root.y);
      this.bubblesC.addChild(c);
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
      s.starving = a.alive && hungerLevel(a.food) === "starving";
      if (!s.starving) s.pulse.visible = false;
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
        s.label.destroy();
        s.bubble?.destroy({ children: true });
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
    let visible = food.length !== this.tileFood.length;
    for (let i = 0; !visible && i < food.length; i++) {
      if (food[i] === this.tileFood[i]) continue;
      const cap = this.tiles[i]?.foodCap ?? 0;
      visible = foodShade(food[i]!, cap) !== foodShade(this.tileFood[i] ?? 0, cap);
    }
    this.tileFood = food;
    if (visible) this.foodDirty = true;
  }

  /** Feed newly arrived world events (same objects the chronicle receives). Drives transient map effects. */
  pushEvents(events: readonly WorldEvent[]): void {
    if (!events.length || !this.state) return;
    const living = new Set<string>();
    for (const a of this.state.agents) if (a.alive && this.sprites.has(a.id)) living.add(a.id);
    const plan = planEffects(events, living, this.state.tick);
    const now = performance.now();
    for (const req of plan.glyphs) this.showGlyph(req.agentId, req.glyph, now);
    for (const req of plan.arcs) {
      if (this.arcs.length >= MAX_EFFECTS) this.arcs.shift();
      this.arcs.push({ from: req.from, to: req.to, born: now });
    }
  }

  /** One glyph per node: reuse that node's badge, else a free one, else the oldest. Pool never exceeds MAX_EFFECTS. */
  private showGlyph(agentId: string, kind: GlyphKind, now: number): void {
    let fx = this.glyphs.find((f) => f.active && f.agentId === agentId) ?? this.glyphs.find((f) => !f.active);
    if (!fx && this.glyphs.length < MAX_EFFECTS) {
      const root = new Container();
      const g = new Graphics();
      root.addChild(g);
      this.glyphC.addChild(root);
      fx = { root, g, agentId, born: now, active: false };
      this.glyphs.push(fx);
    }
    if (!fx) fx = this.glyphs.reduce((a, b) => (b.born < a.born ? b : a));
    fx.agentId = agentId;
    fx.born = now;
    fx.active = true;
    fx.g.clear();
    drawGlyph(fx.g, kind);
    fx.root.visible = true;
  }

  private drawEffects(now: number): void {
    const k = Math.min(1 / Math.max(0.25, this.cam.zoom), 3.2);
    for (const fx of this.glyphs) {
      if (!fx.active) continue;
      const s = this.sprites.get(fx.agentId);
      const age = now - fx.born;
      const alpha = s && s.alive ? fadeAlpha(age, GLYPH_MS) : 0;
      if (alpha <= 0) {
        fx.active = false;
        fx.root.visible = false;
        continue;
      }
      // upper-right of the node, clear of the name label below; drifts up a little as it fades
      const off = HUNGER_R + GLYPH_R * k;
      fx.root.position.set(s!.root.x + off * 0.8, s!.root.y - off * 0.8 - (age / GLYPH_MS) * 6 * k);
      fx.root.scale.set(k);
      fx.root.alpha = alpha;
    }

    const g = this.arcG;
    g.clear();
    if (!this.arcs.length) return;
    const w = 1.6 * k;
    this.arcs = this.arcs.filter((arc) => {
      const a = this.sprites.get(arc.from);
      const b = this.sprites.get(arc.to);
      const age = now - arc.born;
      const alpha = a && b && a.alive && b.alive ? fadeAlpha(age, ARC_MS, 0.5) : 0;
      if (alpha <= 0) return false;
      const p0 = { x: a!.root.x, y: a!.root.y };
      const p1 = { x: b!.root.x, y: b!.root.y };
      const c = arcControl(p0, p1, HEX_SIZE * 3);
      g.moveTo(p0.x, p0.y).quadraticCurveTo(c.x, c.y, p1.x, p1.y).stroke({ color: MESSAGE_COLOR, width: w, alpha: alpha * 0.55 });
      // a dot travels sender -> target over the first 60% of the arc's life
      const t = Math.min(1, age / (ARC_MS * 0.6));
      const d = quadPoint(p0, c, p1, t);
      g.circle(d.x, d.y, 3.2 * k).fill({ color: MESSAGE_COLOR, alpha });
      g.circle(d.x, d.y, 3.2 * k).stroke({ color: INK, width: k, alpha: alpha * 0.8 });
      return true;
    });
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
      this.drawTerrain();
      this.foodDirty = false;
      this.lastFoodDraw = now;
    }
    if (now - this.lastDeclutter > 120) {
      this.declutterLabels();
      this.lastDeclutter = now;
    }
    const fade = Math.min(1, dt * 10);
    for (const s of this.sprites.values()) {
      const target = s.labelShown ? (s.alive ? 1 : 0.5) : 0;
      if (s.label.alpha !== target) s.label.alpha = Math.abs(target - s.label.alpha) < 0.02 ? target : s.label.alpha + (target - s.label.alpha) * fade;
      const k = 1 - Math.pow(0.001, dt);
      s.root.x += (s.tx - s.root.x) * k;
      s.root.y += (s.ty - s.root.y) * k;
      s.label.position.set(s.root.x, s.root.y + LABEL_DY);
      if (s.bubble?.visible) s.bubble.position.set(s.root.x, s.root.y);
      if (s.thinking) {
        const t = (now % 1400) / 1400;
        const r = THINK_R + t * HEX_SIZE * 0.45;
        s.ring.clear();
        s.ring.circle(0, 0, r).stroke({ color: 0x7ff3ff, width: 2, alpha: (1 - t) * 0.9 });
        s.ring.circle(0, 0, THINK_R).stroke({ color: 0x7ff3ff, width: 1.5, alpha: 0.6 });
      }
      if (s.starving) {
        // gentle red breathing halo, ~1.6 s period
        const w = 0.5 + 0.5 * Math.sin((now / 1600) * Math.PI * 2);
        s.pulse.visible = true;
        s.pulse.alpha = 0.2 + w * 0.5;
        s.pulse.scale.set(1 + w * 0.18);
      }
      if (s.bubble && s.bubble.visible) {
        const age = (now - s.bubbleShownAt) / 1000;
        if (age > 6.5) s.bubble.visible = false;
        else if (age > 5) s.bubble.alpha = Math.max(0, 1 - (age - 5) / 1.5);
      }
    }
    this.drawLineage();
    this.drawEffects(now);
    // ruin labels keep screen size
    const ls = Math.min(1 / Math.max(0.25, this.cam.zoom), 3.2);
    for (const c of this.ruinsG.children) {
      const lbl = (c as Container).children[1];
      if (lbl && lbl.scale.x !== ls) lbl.scale.set(ls);
    }
  }

  /** Hide name labels that would overlap a higher-priority one; selected and thinking nodes always keep theirs. */
  private declutterLabels(): void {
    const boxes: LabelBox[] = [];
    for (const [id, s] of this.sprites) {
      const l = s.label;
      const priority =
        id === this.selectedId ? LABEL_PRIORITY.selected : s.thinking ? LABEL_PRIORITY.thinking : s.alive ? LABEL_PRIORITY.alive : LABEL_PRIORITY.dead;
      // world units: the label is counter-scaled, so width/height already include its scale
      boxes.push({ id, x: l.x - l.width / 2, y: l.y, w: l.width, h: l.height, priority });
    }
    const shown = visibleLabels(boxes, 2 / Math.max(0.25, this.cam.zoom));
    for (const [id, s] of this.sprites) s.labelShown = shown.has(id);
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
    case "monolith": {
      // tall standing stone, lit edge; the carved riddle is read in the dossier
      g.poly([0, -S * 0.7, -S * 0.26, -S * 0.45, -S * 0.22, S * 0.42, S * 0.22, S * 0.42, S * 0.26, -S * 0.45]).fill({ color: 0x3a3428 });
      g.poly([0, -S * 0.7, -S * 0.26, -S * 0.45, -S * 0.22, S * 0.42, S * 0.22, S * 0.42, S * 0.26, -S * 0.45]).stroke({ color: col, width: 1.6, alpha: 0.95 });
      for (let i = 0; i < 3; i++) g.moveTo(-S * 0.1, -S * 0.2 + i * S * 0.16).lineTo(S * 0.1, -S * 0.2 + i * S * 0.16);
      g.stroke({ color: col, width: 1, alpha: 0.7 });
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
    case "gate": {
      // two posts and a crossbar on the causeway; the bar is down while locked, raised once open
      const a = locked ? 0.7 : 1;
      g.rect(-S * 0.34, -S * 0.5, S * 0.12, S * 0.95).fill({ color: col, alpha: a });
      g.rect(S * 0.22, -S * 0.5, S * 0.12, S * 0.95).fill({ color: col, alpha: a });
      g.rect(-S * 0.34, -S * 0.5, S * 0.12, S * 0.95).stroke({ color: INK, width: 1, alpha: 0.8 });
      g.rect(S * 0.22, -S * 0.5, S * 0.12, S * 0.95).stroke({ color: INK, width: 1, alpha: 0.8 });
      if (locked) {
        g.rect(-S * 0.34, -S * 0.08, S * 0.68, S * 0.1).fill({ color: 0x3a3428 });
        g.rect(-S * 0.34, S * 0.14, S * 0.68, S * 0.1).fill({ color: 0x3a3428 });
        g.rect(-S * 0.34, -S * 0.08, S * 0.68, S * 0.1).stroke({ color: col, width: 1, alpha: 0.9 });
        g.rect(-S * 0.34, S * 0.14, S * 0.68, S * 0.1).stroke({ color: col, width: 1, alpha: 0.9 });
      } else {
        g.rect(-S * 0.34, -S * 0.56, S * 0.68, S * 0.1).fill({ color: col });
        g.rect(-S * 0.34, -S * 0.56, S * 0.68, S * 0.1).stroke({ color: INK, width: 1, alpha: 0.8 });
      }
      break;
    }
    case "device":
    case "well":
    case "bell": {
      g.circle(0, 0, S * 0.28).fill({ color: col });
      g.circle(0, 0, S * 0.28).stroke({ color: INK, width: 1.4 });
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

/** Action badge (screen-pixel units, centred on 0,0): dark disc, coloured rim, a simple vector symbol. */
function drawGlyph(g: Graphics, kind: GlyphKind): void {
  const R = GLYPH_R;
  const col = GLYPH_COLOR[kind];
  g.circle(0, 0, R).fill({ color: INK, alpha: 0.88 });
  g.circle(0, 0, R).stroke({ color: col, width: 1.2, alpha: 0.95 });
  const line = { color: col, width: 1.6, cap: "round" as const, join: "round" as const };
  switch (kind) {
    case "gathered": // arrow up into a basket
      g.moveTo(0, 1).lineTo(0, -4.5).moveTo(-2.5, -2).lineTo(0, -4.5).lineTo(2.5, -2).stroke(line);
      g.moveTo(-4, 1.5).lineTo(-3, 4.5).lineTo(3, 4.5).lineTo(4, 1.5).stroke(line);
      break;
    case "ate": // round morsel with a bite taken out
      g.circle(0, 0, 4).fill({ color: col });
      g.circle(3.6, -2.6, 2.2).fill({ color: INK });
      break;
    case "rested": // z
      g.moveTo(-3.5, -3.5).lineTo(3.5, -3.5).lineTo(-3.5, 3.5).lineTo(3.5, 3.5).stroke(line);
      break;
    case "built": // house
      g.poly([-4.5, -0.5, 0, -4.8, 4.5, -0.5]).stroke(line);
      g.rect(-3.2, -0.5, 6.4, 4.8).stroke(line);
      break;
    case "planted": // sprout
      g.moveTo(0, 4.5).lineTo(0, -1).stroke(line);
      g.ellipse(-2.4, -2.2, 2.4, 1.3).fill({ color: col });
      g.ellipse(2.4, -3.2, 2.4, 1.3).fill({ color: col });
      break;
    case "dropped": // arrow down onto the ground
      g.moveTo(0, -4.5).lineTo(0, 2).moveTo(-2.5, -0.5).lineTo(0, 2).lineTo(2.5, -0.5).stroke(line);
      g.moveTo(-4, 4.5).lineTo(4, 4.5).stroke(line);
      break;
    case "replicated": // two overlapping nodes
      g.circle(-1.8, 0, 3).stroke(line);
      g.circle(1.8, 0, 3).fill({ color: col });
      break;
    case "took-item": // hand-held square with an up arrow
      g.rect(-3, 0, 6, 4.5).fill({ color: col });
      g.moveTo(0, -1.5).lineTo(0, -5).moveTo(-2, -3).lineTo(0, -5).lineTo(2, -3).stroke(line);
      break;
  }
}

const GLYPH_COLOR: Record<GlyphKind, number> = {
  gathered: 0x5fd08a,
  ate: 0xffcf6b,
  rested: 0x9fd8ff,
  built: 0xe0b872,
  planted: 0x8fe39a,
  dropped: 0xc9ced8,
  replicated: 0x7ff3ff,
  "took-item": 0xe6e9ef,
};

function drawItemCluster(g: Graphics, x: number, y: number): void {
  const S = HEX_SIZE;
  g.circle(x, y, S * 0.36).fill({ color: 0xffffff, alpha: 0.1 });
  g.circle(x, y, S * 0.36).stroke({ color: 0xffffff, width: 1, alpha: 0.35 });
  for (let i = 0; i < 3; i++) {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
    g.circle(x + Math.cos(ang) * S * 0.36, y + Math.sin(ang) * S * 0.36, 1.6).fill({ color: 0xffffff, alpha: 0.9 });
  }
}
