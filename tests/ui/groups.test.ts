import { describe, expect, test } from "bun:test";
import type { AgentView, RuinView } from "../../src/shared/protocol";
import { deriveGroups, emblemFor, safeColor, tagChips, UNAFFILIATED_KEY, groupOf } from "../../ui/lib/groups";

function agent(over: Partial<AgentView> & { id: string }): AgentView {
  return {
    name: over.id,
    color: "#ff0000",
    q: 0,
    r: 0,
    alive: true,
    bornTick: 0,
    food: 50,
    energy: 50,
    health: 100,
    inventory: { food: 0, wood: 0, stone: 0, items: [] },
    profile: {},
    thinking: false,
    fileCount: 1,
    fsBytes: 10,
    turns: 0,
    ...over,
  };
}

describe("deriveGroups", () => {
  test("no agents -> no cards", () => {
    expect(deriveGroups([])).toEqual([]);
  });
  test("agents without profiles fall into one unaffiliated card", () => {
    const cards = deriveGroups([agent({ id: "a" }), agent({ id: "b" })]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.key).toBe(UNAFFILIATED_KEY);
    expect(cards[0]!.unaffiliated).toBe(true);
    expect(cards[0]!.members).toHaveLength(2);
    expect(cards[0]!.alive).toBe(2);
  });
  test("groups come only from profile.group (case-insensitive key, first spelling kept)", () => {
    const cards = deriveGroups([
      agent({ id: "a", profile: { group: "River Folk" }, food: 80, color: "#112233" }),
      agent({ id: "b", profile: { group: "river folk" }, food: 40 }),
      agent({ id: "c", profile: { group: "Stone" } }),
      agent({ id: "d" }),
    ]);
    expect(cards.map((c) => c.name)).toEqual(["River Folk", "Stone", "unaffiliated"]);
    const river = cards[0]!;
    expect(river.members).toHaveLength(2);
    expect(river.avgFood).toBeCloseTo(60, 8);
    expect(river.color).toBe("#112233"); // first member's engine colour
    expect(river.emblem).toBe("R");
  });
  test("declared color / emblem / status are respected; bad colours ignored", () => {
    const cards = deriveGroups([
      agent({ id: "a", profile: { group: "Moss", color: "url(javascript:x)", emblem: "🌿", status: "foraging" } }),
      agent({ id: "b", profile: { group: "Moss", color: "#0f0", status: "foraging" } }),
    ]);
    expect(cards[0]!.color).toBe("#0f0");
    expect(cards[0]!.emblem).toBe("🌿");
    expect(cards[0]!.statuses).toEqual(["foraging"]);
  });
  test("dead members counted, all-dead groups flagged collapsed and sorted last", () => {
    const cards = deriveGroups([
      agent({ id: "a", profile: { group: "Gone" }, alive: false, diedTick: 5 }),
      agent({ id: "b", profile: { group: "Here" } }),
      agent({ id: "c", profile: { group: "Here" }, alive: false }),
    ]);
    expect(cards.map((c) => c.name)).toEqual(["Here", "Gone"]);
    expect(cards[0]!.alive).toBe(1);
    expect(cards[0]!.dead).toBe(1);
    expect(cards[0]!.collapsed).toBe(false);
    expect(cards[1]!.collapsed).toBe(true);
    expect(cards[1]!.avgFood).toBe(0);
  });
  test("ruins are included as dead members and de-duplicated against agents", () => {
    const ruin: RuinView = { id: "r1", name: "Old", color: "#abc", q: 1, r: 1, diedTick: 9, fileCount: 2, profile: { group: "Here" } };
    const cards = deriveGroups([agent({ id: "b", profile: { group: "Here" } }), agent({ id: "r1", alive: false, profile: { group: "Here" } })], [ruin]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.members).toHaveLength(2);
    expect(cards[0]!.dead).toBe(1);
  });
  test("whitespace-only group counts as no group", () => {
    const cards = deriveGroups([agent({ id: "a", profile: { group: "   " } })]);
    expect(cards[0]!.unaffiliated).toBe(true);
    expect(groupOf({ profile: { group: "  " } })).toBeUndefined();
  });
});

describe("helpers", () => {
  test("safeColor", () => {
    expect(safeColor("#abc")).toBe("#abc");
    expect(safeColor("aabbcc")).toBe("#aabbcc");
    expect(safeColor("red")).toBeUndefined();
    expect(safeColor(undefined)).toBeUndefined();
  });
  test("emblemFor", () => {
    expect(emblemFor("moss")).toBe("M");
    expect(emblemFor("moss", "✦")).toBe("✦");
    expect(emblemFor("", "")).toBe("?");
  });
  test("tagChips skips special keys and caps length", () => {
    const chips = tagChips({ group: "x", status: "y", color: "#fff", emblem: "e", mood: "curious", goal: "find water" });
    expect(chips).toEqual([
      { key: "mood", value: "curious" },
      { key: "goal", value: "find water" },
    ]);
    expect(tagChips(undefined)).toEqual([]);
  });
});
