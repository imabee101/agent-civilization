/**
 * PixiJS v8 renderer for the hex world. All camera math lives in lib/camera.ts.
 */
import { Application, Container, Graphics, Text, type TextStyleOptions } from "pixi.js";
import type { AgentView, RuinView, TileView, WorldState, Phase } from "../src/shared/protocol";
import {
  hexToPixel,
  hexCorners,
  worldBounds,
  fitCamera,
  clampZoom,
  zoomAt,
  screenToWorld,
  visibleWorldRect,
  type CameraState,
  type Bounds,
} from "./lib/camera";
import { tintFor } from "./lib/phase";

export const HEX_SIZE = 24;
export const FIT_PADDING = 8;

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
  onCameraChange(): void;
}

const LABEL_STYLE: TextStyleOptions = {
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 11,
  fontWeight: "600",
  fill: 0xe6e9ef,
  stroke: { color: 0x0a0d14, width: 3 },
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
  private terrainG = new Graphics();
  private foodG = new Graphics();
  private ruinsG = new Container();
  private agentsC = new Container();
  private overlay = new Graphics();
  private dim = new Graphics();
  private sprites = new Map<string, AgentSprite>();
  private ruinIds = "";
  tiles: TileView[] = [];
  tileFood: number[] = [];
  mapRadius = 0;
  bounds: Bounds = worldBounds(0, HEX_SIZE);
  cam: CameraState = { cx: 0, cy: 0, zoom: 1 };
  private fitZoomValue = 1;
  private userMoved = false;
  private foodDirty = false;
  private lastFoodDraw = 0;
  private phase: Phase = "day";
  private dayProgress = 0.3;
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
    this.world.addChild(this.terrainG, this.foodG, this.ruinsG, this.agentsC);
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
    this.tileFood = tiles.map((t) => t.food);
    this.bounds = worldBounds(radius, HEX_SIZE);
    this.drawTerrain();
    this.foodDirty = true;
    this.userMoved = false;
    this.fit();
  }

  /** Fit the whole world to the live viewport (min of both ratios). */
  fit(): void {
    const cam = fitCamera(this.viewportW, this.viewportH, this.bounds, FIT_PADDING);
    this.fitZoomValue = cam.zoom;
    this.cam = cam;
    this.userMoved = false;
    this.applyCamera();
  }

  private onResize(): void {
    if (!this.ready) return;
    const prevFit = this.fitZoomValue;
    const fitted = fitCamera(this.viewportW, this.viewportH, this.bounds, FIT_PADDING);
    this.fitZoomValue = fitted.zoom;
    if (!this.userMoved) {
      this.cam = fitted;
    } else {
      // keep the user's zoom relative to the fit zoom
      const factor = prevFit > 0 ? this.cam.zoom / prevFit : 1;
      this.cam = { cx: this.cam.cx, cy: this.cam.cy, zoom: clampZoom(fitted.zoom * factor, fitted.zoom) };
    }
    this.drawOverlay();
    this.applyCamera();
  }

  private applyCamera(): void {
    const { cx, cy, zoom } = this.cam;
    this.world.scale.set(zoom);
    this.world.position.set(this.viewportW / 2 - cx * zoom, this.viewportH / 2 - cy * zoom);
    for (const s of this.sprites.values()) this.counterScale(s);
    this.cbs.onCameraChange();
  }

  centerOn(wx: number, wy: number): void {
    this.userMoved = true;
    this.cam = { ...this.cam, cx: wx, cy: wy };
    this.applyCamera();
  }

  visibleRect(): Bounds {
    return visibleWorldRect(this.cam, this.viewportW, this.viewportH);
  }

  // ---------- drawing ----------

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

  private drawOverlay(): void {
    const t = tintFor(this.phase, this.dayProgress);
    const w = this.viewportW;
    const h = this.viewportH;
    this.overlay.clear();
    this.overlay.rect(0, 0, w, h).fill({ color: hexNum(t.color), alpha: t.alpha });
    this.dim.clear();
    this.dim.rect(0, 0, w, h).fill({ color: 0x000000, alpha: (1 - t.brightness) * 0.75 });
  }

  setPhase(phase: Phase, dayProgress: number): void {
    if (phase === this.phase && Math.abs(dayProgress - this.dayProgress) < 0.002) return;
    this.phase = phase;
    this.dayProgress = dayProgress;
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
    this.setPhase(state.phase, state.dayProgress);
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
    // ruin labels keep screen size
    const ls = Math.min(1 / Math.max(0.25, this.cam.zoom), 3.2);
    for (const c of this.ruinsG.children) {
      const lbl = (c as Container).children[1];
      if (lbl && lbl.scale.x !== ls) lbl.scale.set(ls);
    }
  }

  // ---------- pointer / camera interaction ----------

  private bindPointer(): void {
    const el = this.host;
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
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
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2 && this.pinchStart) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
        const z = clampZoom((this.pinchStart.zoom * dist) / Math.max(1, this.pinchStart.dist), this.fitZoomValue);
        this.userMoved = true;
        this.cam = zoomAt(this.cam, z, mid, this.viewportW, this.viewportH);
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
          this.cam = { ...this.cam, cx: this.dragStart.cx - dx / this.cam.zoom, cy: this.dragStart.cy - dy / this.cam.zoom };
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
        const z = clampZoom(this.cam.zoom * factor, this.fitZoomValue);
        this.userMoved = true;
        this.cam = zoomAt(this.cam, z, { x: e.clientX, y: e.clientY }, this.viewportW, this.viewportH);
        this.applyCamera();
      },
      { passive: false },
    );
    el.addEventListener("dblclick", () => this.fit());
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
    this.cbs.onSelect(best ? best.id : null);
  }
}
