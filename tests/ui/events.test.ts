import { describe, expect, test } from "bun:test";
import type { EventKind, WorldEvent } from "../../src/shared/protocol";
import {
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
  test("hasQuote only for spoke / sent-message with a non-empty quote", () => {
    expect(hasQuote({ kind: "spoke", quote: "hi" })).toBe(true);
    expect(hasQuote({ kind: "sent-message", quote: "{}" })).toBe(true);
    expect(hasQuote({ kind: "spoke", quote: "" })).toBe(false);
    expect(hasQuote({ kind: "moved", quote: "hi" })).toBe(false);
  });
});
