import { describe, expect, test } from "bun:test";
import type { EventKind, WorldEvent } from "../../src/shared/protocol";
import {
  isStory,
  categoryOf,
  iconOf,
  colorOf,
  colorOfCategory,
  formatEventMeta,
  isRibbonWorthy,
  hasQuote,
  ribbonKicker,
  CATEGORIES,
} from "../../ui/lib/events";

// Every EventKind from protocol.ts. If the union grows, this list must grow
// (TypeScript will flag a missing member via the Record below).
const ALL_KINDS: Record<EventKind, true> = {
  spawned: true,
  moved: true,
  spoke: true,
  "sent-message": true,
  gathered: true,
  ate: true,
  dropped: true,
  rested: true,
  "executed-code": true,
  "code-error": true,
  "files-changed": true,
  "profile-changed": true,
  starving: true,
  exhausted: true,
  died: true,
  "ruin-read": true,
  replicated: true,
  "season-changed": true,
  built: true,
  demolished: true,
  posted: true,
  cached: true,
  "took-item": true,
  "dropped-item": true,
  planted: true,
  "vault-opened": true,
  "era-began": true,
  "riddle-answered": true,
  "ruin-lost": true,
  found: true,
  "handler-error": true,
  snapshot: true,
  "world-reset": true,
  "brain-status": true,
};
const KINDS = Object.keys(ALL_KINDS) as EventKind[];

const FORBIDDEN = /faction|war|alliance|colony|hack|steal|betray|invite|sabotage|backdoor/i;

describe("categoryOf / iconOf / colorOf", () => {
  test("every EventKind has a generic category, icon and colour", () => {
    for (const k of KINDS) {
      const cat = categoryOf(k);
      expect(CATEGORIES).toContain(cat);
      expect(iconOf(k).length).toBeGreaterThan(0);
      expect(colorOf(k)).toMatch(/^var\(--[a-z-]+\)$/);
      expect(colorOfCategory(cat)).toMatch(/^var\(--[a-z-]+\)$/);
      expect(ribbonKicker(k)).not.toMatch(FORBIDDEN);
    }
  });
  test("categories contain no social/engine-imposed words", () => {
    for (const c of CATEGORIES) expect(c).not.toMatch(FORBIDDEN);
  });
  test("specific mappings", () => {
    expect(categoryOf("spoke")).toBe("comms");
    expect(categoryOf("sent-message")).toBe("comms");
    expect(categoryOf("executed-code")).toBe("code");
    expect(categoryOf("files-changed")).toBe("code");
    expect(categoryOf("died")).toBe("life");
    expect(categoryOf("spawned")).toBe("life");
    expect(categoryOf("ate")).toBe("survival");
    expect(categoryOf("moved")).toBe("motion");
    expect(categoryOf("world-reset")).toBe("system");
  });
  test("replicated is a life event in gold; season-changed is system", () => {
    expect(categoryOf("replicated")).toBe("life");
    expect(colorOf("replicated")).toBe("var(--accent)");
    expect(categoryOf("season-changed")).toBe("system");
    expect(colorOf("season-changed")).toBe("var(--dim)");
    expect(ribbonKicker("replicated")).toBe("a new node");
    expect(ribbonKicker("season-changed")).toBe("a season turns");
    expect(hasQuote({ kind: "replicated", quote: "x" })).toBe(false);
  });
  test("structure / item kinds map to build, comms and items", () => {
    expect(categoryOf("built")).toBe("build");
    expect(categoryOf("demolished")).toBe("build");
    expect(categoryOf("planted")).toBe("build");
    expect(categoryOf("vault-opened")).toBe("build");
    expect(categoryOf("posted")).toBe("comms");
    expect(categoryOf("cached")).toBe("comms");
    expect(categoryOf("took-item")).toBe("items");
    expect(categoryOf("dropped-item")).toBe("items");
    expect(categoryOf("found")).toBe("items");
  });
  test("build kinds are gold, comms cyan, items teal; none are danger", () => {
    for (const k of ["built", "demolished", "planted", "vault-opened"] as const) expect(colorOf(k)).toBe("var(--accent)");
    for (const k of ["posted", "cached"] as const) expect(colorOf(k)).toBe("var(--cyan)");
    for (const k of ["took-item", "dropped-item", "found"] as const) expect(colorOf(k)).toBe("var(--ally)");
  });
  test("new kinds have distinct icons from each other", () => {
    const icons = ["built", "demolished", "planted", "vault-opened", "posted", "cached", "took-item", "dropped-item", "found", "replicated", "season-changed", "spawned", "died"].map((k) => iconOf(k as EventKind));
    expect(new Set(icons).size).toBe(icons.length);
  });
  test("ribbon kicker for the vault and build kinds is literal, not social", () => {
    expect(ribbonKicker("vault-opened")).toBe("a door opens");
    expect(ribbonKicker("built")).toBe("something made");
    expect(ribbonKicker("found")).toBe("something carried");
    expect(ribbonKicker("posted")).toBe("a message");
  });
  test("harmful kinds use the danger token, others their category colour", () => {
    expect(colorOf("died")).toBe("var(--danger)");
    expect(colorOf("code-error")).toBe("var(--danger)");
    expect(colorOf("spoke")).toBe("var(--cyan)");
    expect(colorOf("ate")).toBe("var(--ally)");
    expect(colorOf("spawned")).toBe("var(--accent)");
  });
});

describe("formatEventMeta / ribbon / quotes", () => {
  const base: WorldEvent = { id: 1, tick: 1204, day: 3, kind: "moved", importance: 0, text: "Ash moved" };
  test("meta line has day, tick and name in order", () => {
    expect(formatEventMeta({ ...base, agentName: "Ash" })).toBe("d3 · t1204 · Ash · moved");
    expect(formatEventMeta(base)).toBe("d3 · t1204 · moved");
  });
  test("only importance 3 triggers the ribbon", () => {
    expect(isRibbonWorthy({ importance: 0 })).toBe(false);
    expect(isRibbonWorthy({ importance: 2 })).toBe(false);
    expect(isRibbonWorthy({ importance: 3 })).toBe(true);
  });
  test("hasQuote only for literal agent text with a non-empty quote", () => {
    expect(hasQuote({ kind: "spoke", quote: "hi" })).toBe(true);
    expect(hasQuote({ kind: "sent-message", quote: "{}" })).toBe(true);
    expect(hasQuote({ kind: "posted", quote: "take turns at the spring" })).toBe(true);
    expect(hasQuote({ kind: "cached", quote: "msg-12-hello" })).toBe(true);
    expect(hasQuote({ kind: "built", quote: "north is that way" })).toBe(true);
    expect(hasQuote({ kind: "spoke", quote: "" })).toBe(false);
    expect(hasQuote({ kind: "posted", quote: "" })).toBe(false);
    expect(hasQuote({ kind: "moved", quote: "hi" })).toBe(false);
    expect(hasQuote({ kind: "found", quote: "hi" })).toBe(false);
    expect(hasQuote({ kind: "vault-opened", quote: "hi" })).toBe(false);
  });
});

describe("isStory", () => {
  test("keeps what a viewer follows, drops upkeep and code runs", () => {
    for (const k of ["spawned", "died", "spoke", "sent-message", "built", "dropped", "profile-changed", "starving"] as EventKind[]) expect(isStory({ kind: k })).toBe(true);
    for (const k of ["moved", "gathered", "ate", "rested", "executed-code", "code-error", "snapshot", "brain-status"] as EventKind[]) expect(isStory({ kind: k })).toBe(false);
  });
});
