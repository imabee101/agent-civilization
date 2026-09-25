import { describe, expect, test } from "bun:test";
import type { ItemKind, StructureKind, TileView } from "../../src/shared/protocol";
import {
  ITEM_GLYPH,
  STRUCTURE_COLOR,
  STRUCTURE_GLYPH,
  STRUCTURE_KINDS,
  STRUCTURE_LABEL,
  formatCacheEntry,
  indexTiles,
  listFeatures,
  mergeTiles,
  structureCss,
  structureCount,
  structureSummary,
  tileDossier,
  tileHasInterest,
  tileKey,
} from "../../ui/lib/structures";

// Every StructureKind / ItemKind from protocol.ts; TypeScript flags a missing member.
const ALL_STRUCTURES: Record<StructureKind, true> = { sign: true, board: true, cache: true, wall: true, tower: true, vault: true, spring: true, plaque: true, monolith: true };
const ALL_ITEMS: Record<ItemKind, true> = { key: true, relay: true, lantern: true, seeds: true, map: true };
const SKINDS = Object.keys(ALL_STRUCTURES) as StructureKind[];
const IKINDS = Object.keys(ALL_ITEMS) as ItemKind[];

const tile = (over: Partial<TileView> = {}): TileView => ({ q: 0, r: 0, terrain: "grass", food: 3, foodCap: 5, wood: 0, stone: 0, ...over });

describe("glyphs, labels, colours", () => {
  test("every structure kind has a distinct glyph, a label equal to the wire word and a colour", () => {
    const glyphs = SKINDS.map((k) => STRUCTURE_GLYPH[k]);
    expect(new Set(glyphs).size).toBe(SKINDS.length);
    for (const k of SKINDS) {
      expect(STRUCTURE_GLYPH[k].length).toBeGreaterThan(0);
      expect(STRUCTURE_LABEL[k]).toBe(k);
      expect(STRUCTURE_COLOR[k]).toBeGreaterThanOrEqual(0);
      expect(structureCss(k)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
  test("every item kind has a distinct glyph", () => {
    const glyphs = IKINDS.map((k) => ITEM_GLYPH[k]);
    expect(new Set(glyphs).size).toBe(IKINDS.length);
  });
  test("STRUCTURE_KINDS lists every kind once with the cache first", () => {
    expect([...STRUCTURE_KINDS].sort()).toEqual([...SKINDS].sort());
    expect(STRUCTURE_KINDS[0]).toBe("cache");
  });
});

describe("tileHasInterest / structureSummary / structureCount", () => {
  test("only tiles with a structure or visible items are interesting", () => {
    expect(tileHasInterest(tile())).toBe(false);
    expect(tileHasInterest(tile({ items: [] }))).toBe(false);
    expect(tileHasInterest(tile({ items: ["key"] }))).toBe(true);
    expect(tileHasInterest(tile({ structure: { kind: "wall" } }))).toBe(true);
  });
  test("summaries count posts / entries and report the vault door", () => {
    expect(structureSummary({ kind: "cache", entries: [] })).toBe("0 entries");
    expect(structureSummary({ kind: "cache", entries: [{ name: "a", by: "x", byName: "X", tick: 1, bytes: 0 }] })).toBe("1 entry");
    expect(structureSummary({ kind: "board", posts: [{ tick: 1, by: "x", byName: "X", text: "hi" }, { tick: 2, by: "x", byName: "X", text: "yo" }] })).toBe("2 posts");
    expect(structureSummary({ kind: "vault", locked: true })).toBe("locked");
    expect(structureSummary({ kind: "vault", locked: false })).toBe("open");
    expect(structureSummary({ kind: "sign", text: "north" })).toBe("north");
    expect(structureSummary({ kind: "sign" })).toBe("blank");
    for (const k of SKINDS) expect(structureSummary({ kind: k }).length).toBeGreaterThan(0);
  });
  test("structureCount is the number of posts or entries, else 0", () => {
    expect(structureCount(undefined)).toBe(0);
    expect(structureCount({ kind: "tower" })).toBe(0);
    expect(structureCount({ kind: "board", posts: [{ tick: 1, by: "x", byName: "X", text: "" }] })).toBe(1);
    expect(structureCount({ kind: "cache", entries: [{ name: "a", by: "x", byName: "X", tick: 1, bytes: 0 }, { name: "b", by: "x", byName: "X", tick: 1, bytes: 0 }] })).toBe(2);
  });
});

describe("listFeatures", () => {
  test("lists every structure, cache first, with coordinates and counts", () => {
    const tiles = [
      tile({ q: 4, r: 1, structure: { kind: "tower" } }),
      tile({ q: -2, r: 3, structure: { kind: "board", posts: [{ tick: 0, by: "r", byName: "Elder", text: "a" }] } }),
      tile({ q: 0, r: 0, structure: { kind: "cache", entries: [{ name: "README", by: "r", byName: "Phaseone", tick: 0, bytes: 10 }] } }),
      tile({ q: 1, r: 1, items: ["key"] }),
      tile({ q: 2, r: 2 }),
    ];
    const f = listFeatures(tiles);
    expect(f.map((x) => x.kind)).toEqual(["cache", "board", "tower"]);
    const stone = listFeatures([tile({ q: 3, r: 3, structure: { kind: "monolith", text: "12 times 7.", answered: [{ by: "n1", byName: "Ash", tick: 5, era: 1, no: 1 }] } })])[0]!;
    expect(stone).toMatchObject({ kind: "monolith", count: 1, summary: "1 answered" });
    expect(f[0]).toMatchObject({ key: "0,0", q: 0, r: 0, glyph: STRUCTURE_GLYPH.cache, label: "cache", count: 1, summary: "1 entry" });
    expect(f[1]!.count).toBe(1);
    expect(f[2]!.count).toBe(0);
  });
});

describe("tileDossier", () => {
  test("plain tile with items", () => {
    const d = tileDossier(tile({ q: 2, r: -1, terrain: "sand", food: 1, foodCap: 2, stone: 3, items: ["seeds", "map"] }));
    expect(d.title).toBe("sand tile");
    expect(d.glyph).toBe(ITEM_GLYPH.seeds);
    expect(d.coords).toBe("2, -1");
    expect(d.rows).toEqual([
      ["terrain", "sand"],
      ["position", "2, -1"],
      ["food", "1 / 2"],
      ["wood", "0"],
      ["stone", "3"],
      ["items", "seeds, map"],
    ]);
    expect(d.text).toBeNull();
    expect(d.posts).toEqual([]);
    expect(d.entries).toEqual([]);
    expect(d.items).toEqual(["seeds", "map"]);
    expect(d.locked).toBeNull();
  });
  test("sign / plaque text is passed through verbatim, even when it looks like markup", () => {
    const text = '<b>EVAL BOARD</b> - grade: ??? & "nobody"';
    const d = tileDossier(tile({ structure: { kind: "plaque", text } }));
    expect(d.title).toBe("plaque");
    expect(d.text).toBe(text);
    expect(tileDossier(tile({ structure: { kind: "sign" } })).text).toBe("");
  });
  test("board posts come newest first with literal fields", () => {
    const posts = [
      { tick: 1, by: "r", byName: "Elder", text: "first" },
      { tick: 9, by: "n1", byName: "Ash", text: "<script>second</script>" },
    ];
    const d = tileDossier(tile({ structure: { kind: "board", posts } }));
    expect(d.posts.map((p) => p.text)).toEqual(["<script>second</script>", "first"]);
    expect(d.posts[0]).toEqual(posts[1]!);
    expect(d.rows).toContainEqual(["posts", "2"]);
  });
  test("cache entries are sorted by name and counted", () => {
    const entries = [
      { name: "the-count", by: "r", byName: "Grader", tick: 0, bytes: 52 },
      { name: "README", by: "r", byName: "Phaseone", tick: 0, bytes: 151 },
      { name: "msg-40-hello", by: "n1", byName: "Ash", tick: 40, bytes: 0 },
    ];
    const d = tileDossier(tile({ structure: { kind: "cache", entries } }));
    expect(d.entries.map((e) => e.name)).toEqual(["msg-40-hello", "README", "the-count"]);
    expect(d.rows).toContainEqual(["entries", "3"]);
    expect(d.glyph).toBe(STRUCTURE_GLYPH.cache);
  });
  test("vault reports the door state; builtBy shows when present", () => {
    const locked = tileDossier(tile({ structure: { kind: "vault", locked: true } }));
    expect(locked.locked).toBe(true);
    expect(locked.rows).toContainEqual(["door", "locked"]);
    const open = tileDossier(tile({ structure: { kind: "vault", locked: false } }));
    expect(open.locked).toBe(false);
    expect(open.rows).toContainEqual(["door", "open"]);
    const built = tileDossier(tile({ structure: { kind: "tower", builtBy: "n3" } }));
    expect(built.rows).toContainEqual(["built by", "n3"]);
    expect(built.locked).toBeNull();
  });
  test("monolith dossier: the riddle is the text, answers come newest first", () => {
    const answered = [
      { by: "n1", byName: "Ash", tick: 5, era: 1, no: 1 },
      { by: "n4", byName: "Fern", tick: 90, era: 2, no: 2 },
    ];
    const d = tileDossier(tile({ structure: { kind: "monolith", text: "Read this backwards: REVIR.", answered } }));
    expect(d.title).toBe("monolith");
    expect(d.text).toBe("Read this backwards: REVIR.");
    expect(d.textLabel).toBe("riddle");
    expect(d.answered.map((a) => a.byName)).toEqual(["Fern", "Ash"]);
    expect(d.rows).toContainEqual(["answered", "2"]);
    expect(tileDossier(tile({ structure: { kind: "sign", text: "x" } })).textLabel).toBe("sign text");
  });
  test("every structure kind produces a dossier", () => {
    for (const k of SKINDS) {
      const d = tileDossier(tile({ structure: { kind: k } }));
      expect(d.title).toBe(k);
      expect(d.glyph).toBe(STRUCTURE_GLYPH[k]);
    }
  });
});

describe("formatCacheEntry", () => {
  test("formats tick and bytes like a directory listing", () => {
    expect(formatCacheEntry({ name: "README", by: "r", byName: "Phaseone", tick: 0, bytes: 151 })).toEqual({ name: "README", by: "Phaseone", tick: "t0", bytes: "151B" });
    expect(formatCacheEntry({ name: "big", by: "r", byName: "X", tick: 12, bytes: 2048 })).toEqual({ name: "big", by: "X", tick: "t12", bytes: "2.0K" });
  });
});

describe("indexTiles / mergeTiles", () => {
  test("merge replaces by coordinates in place and appends unknown tiles", () => {
    const tiles = [tile({ q: 0, r: 0 }), tile({ q: 1, r: 0 }), tile({ q: 0, r: 1 })];
    const idx = indexTiles(tiles);
    expect(idx.get(tileKey(1, 0))).toBe(1);
    const changed = mergeTiles(tiles, idx, [tile({ q: 1, r: 0, structure: { kind: "sign", text: "x" } }), tile({ q: 5, r: 5, items: ["key"] })]);
    expect(changed).toEqual(["1,0", "5,5"]);
    expect(tiles.length).toBe(4);
    expect(tiles[1]!.structure?.kind).toBe("sign");
    expect(idx.get("5,5")).toBe(3);
    expect(tiles[3]!.items).toEqual(["key"]);
  });
});
