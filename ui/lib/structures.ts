/**
 * Structure / item presentation helpers. Pure; no DOM, no PixiJS.
 *
 * Everything is keyed on the engine's `StructureKind` / `ItemKind` unions so
 * TypeScript forces this file to grow with the protocol. No meaning is
 * attached to any text found on a structure: it is passed through verbatim.
 */
import type { AnsweredRecord, BoardPost, CacheEntry, ItemKind, StructureKind, TileView } from "../../src/shared/protocol";

/** One-glyph marker per structure kind (used in lists, chips and portraits). */
export const STRUCTURE_GLYPH: Record<StructureKind, string> = {
  sign: "⌇",
  board: "▤",
  cache: "❒",
  wall: "▮",
  tower: "▲",
  vault: "⚿",
  spring: "≋",
  plaque: "▭",
  monolith: "◆",
};

/** Human label per structure kind. Lower-case, matches the wire word. */
export const STRUCTURE_LABEL: Record<StructureKind, string> = {
  sign: "sign",
  board: "board",
  cache: "cache",
  wall: "wall",
  tower: "tower",
  vault: "vault",
  spring: "spring",
  plaque: "plaque",
  monolith: "monolith",
};

/** Marker colour per structure kind as a 24-bit number (PixiJS) . */
export const STRUCTURE_COLOR: Record<StructureKind, number> = {
  sign: 0xd9c28a,
  board: 0xffcf6b,
  cache: 0x7ff3ff,
  wall: 0x1a1d24,
  tower: 0xe6e9ef,
  vault: 0xc4b5fd,
  spring: 0x4fd1c5,
  plaque: 0xd9c28a,
  monolith: 0xf6a83c,
};

/** One-glyph marker per item kind. */
export const ITEM_GLYPH: Record<ItemKind, string> = {
  key: "⚷",
  relay: "⌁",
  lantern: "☼",
  seeds: "∴",
  map: "⌘",
};

/** Sort order for the "World" list: shared / rare things first. */
const KIND_ORDER: Record<StructureKind, number> = {
  cache: 0,
  monolith: 1,
  plaque: 2,
  board: 3,
  vault: 4,
  spring: 5,
  tower: 6,
  sign: 7,
  wall: 8,
};

export const STRUCTURE_KINDS: readonly StructureKind[] = (Object.keys(KIND_ORDER) as StructureKind[]).sort((a, b) => KIND_ORDER[a] - KIND_ORDER[b]);

export const tileKey = (q: number, r: number): string => `${q},${r}`;

/** Whether a tile has something a viewer might want to inspect. */
export function tileHasInterest(t: Pick<TileView, "structure" | "items">): boolean {
  return !!t.structure || (Array.isArray(t.items) && t.items.length > 0);
}

/** A structure's CSS colour as a hex string. */
export function structureCss(kind: StructureKind): string {
  return `#${STRUCTURE_COLOR[kind].toString(16).padStart(6, "0")}`;
}

/** Number of user-authored records on a structure (posts or cache entries). */
export function structureCount(s: TileView["structure"]): number {
  if (!s) return 0;
  if (s.kind === "board") return s.posts?.length ?? 0;
  if (s.kind === "cache") return s.entries?.length ?? 0;
  if (s.kind === "monolith") return s.answered?.length ?? 0;
  return 0;
}

/** Short subtitle for a structure: "4 entries", "2 posts", "locked", sign text… */
export function structureSummary(s: NonNullable<TileView["structure"]>): string {
  switch (s.kind) {
    case "cache": {
      const n = s.entries?.length ?? 0;
      return `${n} ${n === 1 ? "entry" : "entries"}`;
    }
    case "board": {
      const n = s.posts?.length ?? 0;
      return `${n} ${n === 1 ? "post" : "posts"}`;
    }
    case "vault":
      return s.locked ? "locked" : "open";
    case "monolith": {
      const n = s.answered?.length ?? 0;
      return `${n} answered`;
    }
    case "sign":
    case "plaque":
      return s.text ? s.text : "blank";
    case "spring":
      return "fast regrowth";
    case "tower":
      return "extends send range";
    case "wall":
      return "impassable";
  }
}

export interface WorldFeature {
  key: string;
  q: number;
  r: number;
  kind: StructureKind;
  glyph: string;
  label: string;
  summary: string;
  count: number;
}

/** All structures in the world, sorted for the "World" list (cache first). */
export function listFeatures(tiles: readonly TileView[]): WorldFeature[] {
  const out: WorldFeature[] = [];
  for (const t of tiles) {
    const s = t.structure;
    if (!s) continue;
    out.push({ key: tileKey(t.q, t.r), q: t.q, r: t.r, kind: s.kind, glyph: STRUCTURE_GLYPH[s.kind], label: STRUCTURE_LABEL[s.kind], summary: structureSummary(s), count: structureCount(s) });
  }
  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.q - b.q || a.r - b.r);
}

export interface TileDossier {
  /** Title line, e.g. "cache" or "grass tile". */
  title: string;
  glyph: string;
  colorCss: string;
  coords: string;
  terrain: string;
  /** key/value rows to show under the head. */
  rows: [string, string][];
  /** Sign / plaque text, or the monolith's riddle, verbatim. */
  text: string | null;
  /** What the text section is called: "sign text", "riddle"… */
  textLabel: string;
  /** Monolith answers, newest first. */
  answered: AnsweredRecord[];
  /** Board posts, newest first. */
  posts: BoardPost[];
  /** Cache entries in name order. */
  entries: CacheEntry[];
  items: ItemKind[];
  locked: boolean | null;
}

/** Pure formatting for the tile dossier. Agent-written strings are returned as-is. */
export function tileDossier(t: TileView): TileDossier {
  const s = t.structure;
  const items = Array.isArray(t.items) ? [...t.items] : [];
  const rows: [string, string][] = [
    ["terrain", t.terrain],
    ["position", `${t.q}, ${t.r}`],
    ["food", `${t.food} / ${t.foodCap}`],
    ["wood", String(t.wood)],
    ["stone", String(t.stone)],
  ];
  if (s?.builtBy) rows.push(["built by", s.builtBy]);
  if (s?.kind === "vault") rows.push(["door", s.locked ? "locked" : "open"]);
  if (s?.kind === "board") rows.push(["posts", String(s.posts?.length ?? 0)]);
  if (s?.kind === "cache") rows.push(["entries", String(s.entries?.length ?? 0)]);
  if (s?.kind === "monolith") {
    rows.push(["answered", String(s.answered?.length ?? 0)]);
    const voices = s.voices ?? [];
    rows.push(["voices", voices.length ? `${voices.map((v) => v.byName).join(", ")} · ${voices.length} of ${s.voicesNeeded ?? "?"}` : `none yet · needs ${s.voicesNeeded ?? "?"}`]);
  }
  if (items.length) rows.push(["items", items.join(", ")]);
  return {
    title: s ? STRUCTURE_LABEL[s.kind] : `${t.terrain} tile`,
    glyph: s ? STRUCTURE_GLYPH[s.kind] : items[0] ? ITEM_GLYPH[items[0]] : "·",
    colorCss: s ? structureCss(s.kind) : "#8b93a5",
    coords: `${t.q}, ${t.r}`,
    terrain: t.terrain,
    rows,
    text: s && (s.kind === "sign" || s.kind === "plaque" || s.kind === "monolith") ? s.text ?? "" : null,
    textLabel: s?.kind === "monolith" ? "riddle" : `${s ? STRUCTURE_LABEL[s.kind] : "tile"} text`,
    answered: s?.kind === "monolith" ? [...(s.answered ?? [])].reverse() : [],
    posts: s?.kind === "board" ? [...(s.posts ?? [])].reverse() : [],
    entries: s?.kind === "cache" ? [...(s.entries ?? [])].sort((a, b) => a.name.localeCompare(b.name)) : [],
    items,
    locked: s?.kind === "vault" ? !!s.locked : null,
  };
}

/** Directory-listing line for a cache entry (fixed width, like `ls -l`). */
export function formatCacheEntry(e: CacheEntry): { name: string; by: string; tick: string; bytes: string } {
  return { name: e.name, by: e.byName, tick: `t${e.tick}`, bytes: e.bytes >= 1024 ? `${(e.bytes / 1024).toFixed(1)}K` : `${e.bytes}B` };
}

/** Replace tiles in place by (q, r); returns the keys that changed. Unknown tiles are appended. */
export function mergeTiles(tiles: TileView[], index: Map<string, number>, incoming: readonly TileView[]): string[] {
  const changed: string[] = [];
  for (const t of incoming) {
    const k = tileKey(t.q, t.r);
    const i = index.get(k);
    if (i === undefined) {
      index.set(k, tiles.length);
      tiles.push(t);
    } else tiles[i] = t;
    changed.push(k);
  }
  return changed;
}

export function indexTiles(tiles: readonly TileView[]): Map<string, number> {
  const m = new Map<string, number>();
  tiles.forEach((t, i) => m.set(tileKey(t.q, t.r), i));
  return m;
}
