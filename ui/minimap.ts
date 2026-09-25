/** Canvas-2D minimap: whole map, agents, viewport rectangle; click/drag to jump. */
import type { AgentView, RuinView, TileView } from "../src/shared/protocol";
import { hexToPixel, hexCorners, type Bounds } from "./lib/camera";
import { HEX_SIZE, TERRAIN_COLORS } from "./world";

const TERRAIN_CSS: Record<TileView["terrain"], string> = Object.fromEntries(
  Object.entries(TERRAIN_COLORS).map(([k, v]) => [k, `#${v.toString(16).padStart(6, "0")}`]),
) as Record<TileView["terrain"], string>;

export class Minimap {
  private canvas: HTMLCanvasElement;
  private base: HTMLCanvasElement = document.createElement("canvas");
  private tiles: TileView[] = [];
  private bounds: Bounds | null = null;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private dragging = false;
  private lastDraw = 0;
  agents: AgentView[] = [];
  ruins: RuinView[] = [];
  view: Bounds | null = null;
  private onJump: (wx: number, wy: number) => void;

  constructor(canvas: HTMLCanvasElement, onJump: (wx: number, wy: number) => void) {
    this.canvas = canvas;
    this.onJump = onJump;
    const jump = (e: PointerEvent) => {
      if (!this.bounds) return;
      const rect = this.canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
      const py = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
      this.onJump((px - this.ox) / this.scale, (py - this.oy) / this.scale);
    };
    canvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      jump(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (this.dragging) jump(e);
    });
    const stop = () => (this.dragging = false);
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    new ResizeObserver(() => this.layout()).observe(canvas);
  }

  setMap(tiles: TileView[], bounds: Bounds): void {
    this.tiles = tiles;
    this.bounds = bounds;
    this.layout();
  }

  private layout(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.base.width = w;
    this.base.height = h;
    if (!this.bounds) return;
    const pad = 6 * dpr;
    this.scale = Math.min((w - pad * 2) / this.bounds.width, (h - pad * 2) / this.bounds.height);
    this.ox = w / 2;
    this.oy = h / 2;
    const ctx = this.base.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    for (const t of this.tiles) {
      const c = hexToPixel(t.q, t.r, HEX_SIZE);
      const pts = hexCorners(c.x * this.scale + this.ox, c.y * this.scale + this.oy, HEX_SIZE * this.scale);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = TERRAIN_CSS[t.terrain];
      ctx.fill();
    }
    this.draw(true);
  }

  draw(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastDraw < 80) return;
    this.lastDraw = now;
    const ctx = this.canvas.getContext("2d")!;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.base, 0, 0);
    if (!this.bounds) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const r of this.ruins) {
      const c = hexToPixel(r.q, r.r, HEX_SIZE);
      ctx.fillStyle = "rgba(139,147,165,0.6)";
      ctx.beginPath();
      ctx.arc(c.x * this.scale + this.ox, c.y * this.scale + this.oy, 1.6 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const a of this.agents) {
      const c = hexToPixel(a.q, a.r, HEX_SIZE);
      ctx.fillStyle = a.alive ? a.color : "rgba(139,147,165,0.6)";
      ctx.beginPath();
      ctx.arc(c.x * this.scale + this.ox, c.y * this.scale + this.oy, 2.2 * dpr, 0, Math.PI * 2);
      ctx.fill();
      if (a.alive) {
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = 0.8 * dpr;
        ctx.stroke();
      }
    }
    if (this.view) {
      ctx.strokeStyle = "rgba(255,207,107,0.9)";
      ctx.lineWidth = 1 * dpr;
      ctx.strokeRect(
        this.view.minX * this.scale + this.ox,
        this.view.minY * this.scale + this.oy,
        this.view.width * this.scale,
        this.view.height * this.scale,
      );
    }
  }
}
