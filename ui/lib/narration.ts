/**
 * Narration selection. Pure. The only text that may ever be spoken aloud is
 * the engine's literal factual event text and an agent's literal quote —
 * nothing is paraphrased or invented here.
 */
import type { WorldEvent } from "../../src/shared/protocol";

export interface NarrationOptions {
  /** Minimum importance to speak (default 1: skip noise). */
  minImportance?: number;
  /** Hard cap on utterance length, characters. */
  maxChars?: number;
}

/**
 * Returns the string to speak for an event, or null if it should stay silent.
 * The returned string is composed only of `event.text` and `event.quote`
 * joined by punctuation; no other words are added.
 */
export function utteranceFor(e: WorldEvent, opts: NarrationOptions = {}): string | null {
  const min = opts.minImportance ?? 1;
  const max = opts.maxChars ?? 280;
  const text = typeof e.text === "string" ? e.text.trim() : "";
  const quote = (e.kind === "spoke" || e.kind === "sent-message") && typeof e.quote === "string" ? e.quote.trim() : "";
  if (!text && !quote) return null;
  if (e.importance < min && !quote) return null;
  let out = text;
  if (quote) out = out ? `${out}. "${quote}"` : `"${quote}"`;
  if (out.length > max) out = out.slice(0, max - 1) + "…";
  return out;
}
