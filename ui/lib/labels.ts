/**
 * Name-label decluttering. Pure: given label boxes, decide which to show so no
 * two shown labels overlap, except pinned ones (selected / thinking), which always show.
 */

export interface LabelBox {
  id: string;
  /** Top-left corner and size, any consistent unit. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Higher wins a collision. Values >= PINNED always show. */
  priority: number;
}

export const PINNED = 2;
/** Label priorities: selected > thinking > living > dead. */
export const LABEL_PRIORITY = { selected: 3, thinking: PINNED, alive: 1, dead: 0 } as const;

function overlaps(a: LabelBox, b: LabelBox, pad: number): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/**
 * Greedy placement: highest priority first, then the label lower on screen
 * (nearer the viewer), then id for stability. A label is shown when it is
 * pinned or overlaps no label already shown.
 */
export function visibleLabels(boxes: readonly LabelBox[], pad = 0): Set<string> {
  const order = [...boxes].sort((a, b) => b.priority - a.priority || b.y - a.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const shown: LabelBox[] = [];
  const ids = new Set<string>();
  for (const box of order) {
    if (box.priority >= PINNED || !shown.some((s) => overlaps(box, s, pad))) {
      shown.push(box);
      ids.add(box.id);
    }
  }
  return ids;
}
