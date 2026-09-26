import { describe, expect, test } from "bun:test";
import { createDisclosureState, loadUiPreferences, UI_PREFERENCES_KEY } from "../../ui/lib/disclosure";

function storage(seed?: string): Storage {
  const values = new Map<string, string>(seed ? [[UI_PREFERENCES_KEY, seed]] : []);
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("disclosure preferences", () => {
  test("defaults expanded and visible", () => {
    const state = createDisclosureState(null);
    expect(state.isCollapsed("status")).toBe(false);
    expect(state.isVisible("groups")).toBe(true);
  });

  test("toggles and persists a collapsed section", () => {
    const store = storage();
    const state = createDisclosureState(store);
    expect(state.toggle("status")).toBe(true);
    expect(JSON.parse(store.getItem(UI_PREFERENCES_KEY)!)).toEqual({ collapsed: { status: true }, visible: {} });
    expect(createDisclosureState(store).isCollapsed("status")).toBe(true);
  });

  test("persists panel visibility independently", () => {
    const store = storage();
    const state = createDisclosureState(store);
    state.setVisible("groups", false);
    expect(state.isVisible("groups")).toBe(false);
    expect(state.isVisible("chronicle")).toBe(true);
    expect(state.isCollapsed("groups")).toBe(false);
  });

  test("malformed storage becomes empty state", () => {
    expect(loadUiPreferences(storage("not json"))).toEqual({ collapsed: {}, visible: {} });
    expect(loadUiPreferences(storage(JSON.stringify({ collapsed: { ok: true, bad: "yes" }, visible: [] })))).toEqual({ collapsed: { ok: true }, visible: {} });
  });

  test("different keys do not share state", () => {
    const state = createDisclosureState(null);
    state.toggle("a");
    expect(state.isCollapsed("a")).toBe(true);
    expect(state.isCollapsed("b")).toBe(false);
  });
});
