/**
 * Event presentation helpers. Pure; no DOM.
 *
 * Categories are generic and derived from the engine's low-level EventKind —
 * never from social concepts. Colours are returned as CSS var() references so
 * the design tokens remain the single source of truth.
 */
import type { EventKind, WorldEvent } from "../../src/shared/protocol";

export type EventCategory = "life" | "comms" | "code" | "survival" | "motion" | "build" | "items" | "system";

export const CATEGORIES: readonly EventCategory[] = ["life", "comms", "code", "survival", "motion", "build", "items", "system"];

const CATEGORY_OF: Record<EventKind, EventCategory> = {
  spawned: "life",
  died: "life",
  replicated: "life",
  spoke: "comms",
  "sent-message": "comms",
  "executed-code": "code",
  "code-error": "code",
  "files-changed": "code",
  "profile-changed": "code",
  "handler-error": "code",
  gathered: "survival",
  ate: "survival",
  dropped: "survival",
  rested: "survival",
  starving: "survival",
  exhausted: "survival",
  moved: "motion",
  "ruin-read": "motion",
  built: "build",
  demolished: "build",
  planted: "build",
  "vault-opened": "build",
  "gate-opened": "build",
  operator: "system",
  "era-began": "life",
  "ruin-lost": "life",
  "riddle-answered": "build",
  "riddle-voice": "build",
  posted: "comms",
  cached: "comms",
  "took-item": "items",
  "dropped-item": "items",
  found: "items",
  snapshot: "system",
  "season-changed": "system",
  "world-reset": "system",
  "brain-status": "system",
  "same-script": "code",
};

const ICON_OF: Record<EventKind, string> = {
  spawned: "✦",
  died: "✝",
  replicated: "✦✦",
  spoke: "❝",
  "sent-message": "✉",
  "executed-code": "{}",
  "code-error": "✕",
  "files-changed": "▤",
  "profile-changed": "◐",
  "handler-error": "⚠",
  gathered: "❀",
  ate: "◉",
  dropped: "▽",
  rested: "☾",
  starving: "!",
  exhausted: "~",
  moved: "➜",
  "ruin-read": "◌",
  built: "⌂",
  demolished: "⊟",
  planted: "❁",
  "vault-opened": "⚿",
  "gate-opened": "⌸",
  operator: "⊘",
  "era-began": "✶",
  "ruin-lost": "∴",
  "riddle-answered": "◆",
  "riddle-voice": "◇",
  posted: "▤",
  cached: "❒",
  "took-item": "↑",
  "dropped-item": "↓",
  found: "✧",
  snapshot: "◈",
  "season-changed": "❄",
  "world-reset": "↻",
  "brain-status": "◍",
  "same-script": "≡",
};

/** Kinds that indicate something went wrong / is dangerous for the node. */
const DANGER_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "died",
  "starving",
  "exhausted",
  "code-error",
  "handler-error",
]);

export function categoryOf(kind: EventKind): EventCategory {
  return CATEGORY_OF[kind] ?? "system";
}

export function iconOf(kind: EventKind): string {
  return ICON_OF[kind] ?? "•";
}

/** Base colour of a category, as a CSS custom-property reference. */
export function colorOfCategory(cat: EventCategory): string {
  switch (cat) {
    case "life":
      return "var(--accent)";
    case "comms":
      return "var(--cyan)";
    case "code":
      return "var(--cyan)";
    case "survival":
      return "var(--ally)";
    case "motion":
      return "var(--dim)";
    case "build":
      return "var(--accent)";
    case "items":
      return "var(--ally)";
    case "system":
    default:
      return "var(--dim)";
  }
}

/**
 * Colour for a specific kind: category colour, except kinds that signal harm
 * or failure, which use the danger token.
 */
export function colorOf(kind: EventKind): string {
  if (DANGER_KINDS.has(kind)) return "var(--danger)";
  return colorOfCategory(categoryOf(kind));
}

/** Small mono meta line: "d3 · t1204 · Ash". */
export function formatEventMeta(e: Pick<WorldEvent, "day" | "tick" | "agentName" | "kind">): string {
  const parts = [`d${e.day}`, `t${e.tick}`];
  if (e.agentName) parts.push(e.agentName);
  parts.push(e.kind);
  return parts.join(" · ");
}

/** Whether this event should show the cinematic ribbon. */
export function isRibbonWorthy(e: Pick<WorldEvent, "importance">): boolean {
  return e.importance >= 3;
}

/**
 * Kinds whose `quote` is literal agent-authored text: what was said or sent,
 * the text of a post or sign, the name made in the cache.
 */
export const QUOTE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["spoke", "sent-message", "posted", "cached", "built"]);

/** Only literal agent text carries a quote. Never synthesise one. */
export function hasQuote(e: Pick<WorldEvent, "kind" | "quote">): boolean {
  return QUOTE_KINDS.has(e.kind) && typeof e.quote === "string" && e.quote.length > 0;
}

/** Kicker text for the ribbon, derived from the category only. */
export function ribbonKicker(kind: EventKind): string {
  if (kind === "vault-opened") return "a door opens";
  if (kind === "gate-opened") return "the gate opens";
  if (kind === "operator") return "the operator";
  if (kind === "era-began") return "a new era";
  if (kind === "riddle-answered") return "the stone answered";
  if (kind === "riddle-voice") return "the stone waits";
  if (kind === "replicated") return "a new node";
  if (kind === "season-changed") return "a season turns";
  const cat = categoryOf(kind);
  switch (cat) {
    case "life":
      return "a life";
    case "comms":
      return "a message";
    case "code":
      return "code";
    case "survival":
      return "survival";
    case "motion":
      return "movement";
    case "build":
      return "something made";
    case "items":
      return "something carried";
    case "system":
    default:
      return "the world";
  }
}

/**
 * Kinds a viewer follows as the story: arrivals and deaths, what nodes say and
 * send, what they build, share and find, what they declare about themselves.
 * Routine upkeep (gather, eat, rest, move) and code runs are left to the map
 * glyphs and the mind cam.
 */
const STORY: ReadonlySet<EventKind> = new Set<EventKind>([
  "spawned", "died", "replicated", "era-began", "ruin-lost",
  "spoke", "sent-message", "posted", "cached",
  "built", "demolished", "planted", "vault-opened", "gate-opened", "riddle-answered", "riddle-voice",
  "dropped", "took-item", "dropped-item", "found", "ruin-read",
  "profile-changed", "starving", "season-changed", "world-reset", "operator",
]);

export function isStory(e: Pick<WorldEvent, "kind">): boolean {
  return STORY.has(e.kind);
}
