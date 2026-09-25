/**
 * Derive "group cards" purely from what agents declare about themselves in
 * their own profile (`profile.group`). The engine tracks no groups; this is
 * only a view over self-reported strings.
 */
import type { AgentView, RuinView } from "../../src/shared/protocol";

export interface GroupMember {
  id: string;
  name: string;
  color: string;
  alive: boolean;
  food: number;
  health: number;
  energy: number;
  status?: string;
}

export interface GroupCard {
  /** Stable key (group name, or "__unaffiliated"). */
  key: string;
  name: string;
  /** True for the synthetic card holding agents with no group. */
  unaffiliated: boolean;
  color: string;
  emblem: string;
  members: GroupMember[];
  alive: number;
  dead: number;
  /** Average food of living members, 0..100 (0 if none alive). */
  avgFood: number;
  avgHealth: number;
  avgEnergy: number;
  /** True when no member is alive. */
  collapsed: boolean;
  /** Distinct self-declared statuses among living members. */
  statuses: string[];
}

export const UNAFFILIATED_KEY = "__unaffiliated";

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Accept a profile-declared colour only if it is a plain hex string. */
export function safeColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!HEX_RE.test(s)) return undefined;
  return s.startsWith("#") ? s : `#${s}`;
}

function cleanText(v: string | undefined, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length ? s.slice(0, max) : undefined;
}

export function emblemFor(name: string, declared?: string): string {
  const e = cleanText(declared, 4);
  if (e) return [...e].slice(0, 2).join("");
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "?";
}

function toMember(a: AgentView | RuinView): GroupMember {
  const alive = "alive" in a ? a.alive : false;
  return {
    id: a.id,
    name: a.name,
    color: safeColor(a.profile?.color) ?? a.color,
    alive,
    food: "food" in a ? a.food : 0,
    health: "health" in a ? a.health : 0,
    energy: "energy" in a ? a.energy : 0,
    status: cleanText(a.profile?.status, 80),
  };
}

function avg(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function deriveGroups(agents: AgentView[], ruins: RuinView[] = []): GroupCard[] {
  const buckets = new Map<string, { name: string; members: GroupMember[]; declaredColor?: string; declaredEmblem?: string }>();
  const all: (AgentView | RuinView)[] = [...agents, ...ruins];
  const seen = new Set<string>();
  for (const a of all) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const g = cleanText(a.profile?.group, 40);
    const key = g ? g.toLowerCase() : UNAFFILIATED_KEY;
    let b = buckets.get(key);
    if (!b) {
      b = { name: g ?? "unaffiliated", members: [] };
      buckets.set(key, b);
    }
    b.members.push(toMember(a));
    // First declared colour/emblem wins.
    if (!b.declaredColor) b.declaredColor = safeColor(a.profile?.color);
    if (!b.declaredEmblem) b.declaredEmblem = cleanText(a.profile?.emblem, 4);
  }

  const cards: GroupCard[] = [];
  for (const [key, b] of buckets) {
    const living = b.members.filter((m) => m.alive);
    const first = living[0] ?? b.members[0];
    const statuses = [...new Set(living.map((m) => m.status).filter((s): s is string => !!s))];
    cards.push({
      key,
      name: b.name,
      unaffiliated: key === UNAFFILIATED_KEY,
      color: b.declaredColor ?? first?.color ?? "#8b93a5",
      emblem: emblemFor(b.name, b.declaredEmblem),
      members: b.members,
      alive: living.length,
      dead: b.members.length - living.length,
      avgFood: avg(living.map((m) => m.food)),
      avgHealth: avg(living.map((m) => m.health)),
      avgEnergy: avg(living.map((m) => m.energy)),
      collapsed: living.length === 0,
      statuses,
    });
  }

  cards.sort((a, b) => {
    if (a.collapsed !== b.collapsed) return a.collapsed ? 1 : -1;
    if (a.unaffiliated !== b.unaffiliated) return a.unaffiliated ? 1 : -1;
    if (b.alive !== a.alive) return b.alive - a.alive;
    return a.name.localeCompare(b.name);
  });
  return cards;
}

/** Group name (as declared) for one agent, or undefined. */
export function groupOf(a: { profile?: Record<string, string> }): string | undefined {
  return cleanText(a.profile?.group, 40);
}

/** Profile keys that the UI renders specially; every other key becomes a tag chip. */
export const SPECIAL_PROFILE_KEYS: ReadonlySet<string> = new Set(["group", "status", "emblem", "color"]);

export function tagChips(profile: Record<string, string> | undefined, max = 8): { key: string; value: string }[] {
  if (!profile) return [];
  const out: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(profile)) {
    if (SPECIAL_PROFILE_KEYS.has(k)) continue;
    const key = cleanText(k, 24);
    const value = cleanText(v, 40);
    if (!key || !value) continue;
    out.push({ key, value });
    if (out.length >= max) break;
  }
  return out;
}
