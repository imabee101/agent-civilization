export type UiPreferences = {
  collapsed: Record<string, boolean>;
  visible: Record<string, boolean>;
};

export const UI_PREFERENCES_KEY = "agentciv.uiPreferences.v1";

const emptyPreferences = (): UiPreferences => ({ collapsed: {}, visible: {} });

/** Small, defensive preference store. It never lets storage failures affect the UI. */
export function loadUiPreferences(storage?: Storage | null): UiPreferences {
  if (!storage) return emptyPreferences();
  try {
    const raw = storage.getItem(UI_PREFERENCES_KEY);
    if (!raw) return emptyPreferences();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyPreferences();
    const value = parsed as { collapsed?: unknown; visible?: unknown };
    const record = (candidate: unknown): Record<string, boolean> => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
      return Object.fromEntries(Object.entries(candidate).filter(([, v]) => typeof v === "boolean"));
    };
    return { collapsed: record(value.collapsed), visible: record(value.visible) };
  } catch {
    return emptyPreferences();
  }
}

export function createDisclosureState(storage?: Storage | null): {
  isCollapsed: (key: string) => boolean;
  isVisible: (key: string) => boolean;
  toggle: (key: string) => boolean;
  setVisible: (key: string, visible: boolean) => void;
  preferences: () => UiPreferences;
} {
  const preferences = loadUiPreferences(storage);
  const save = (): void => {
    if (!storage) return;
    try {
      storage.setItem(UI_PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      // Private browsing, disabled storage, and quota errors are harmless here.
    }
  };
  return {
    isCollapsed: (key) => preferences.collapsed[key] === true,
    isVisible: (key) => preferences.visible[key] !== false,
    toggle: (key) => {
      preferences.collapsed[key] = !preferences.collapsed[key];
      save();
      return preferences.collapsed[key]!;
    },
    setVisible: (key, visible) => {
      preferences.visible[key] = visible;
      save();
    },
    preferences: () => ({ collapsed: { ...preferences.collapsed }, visible: { ...preferences.visible } }),
  };
}

