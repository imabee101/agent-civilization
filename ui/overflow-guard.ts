/**
 * Overflow guard for floating panels.
 *
 * A scroll container clips its children visually, but their layout boxes
 * still extend past the panel (and, near the screen edge, past the viewport).
 * This guard makes the clipping physical: after every render, scroll or
 * resize it truncates the descendant that straddles the panel's bottom edge
 * (inline `max-height` + `overflow: hidden`, with the cut height returned as
 * margin so scrolling is unaffected) and hides the ones entirely below it. The result looks identical to normal clipping, but no element's
 * bounding box ever leaves its panel, so nothing can leave the viewport.
 */

interface Guard {
  panel: HTMLElement;
  touched: Set<HTMLElement>;
  scheduled: boolean;
  mo: MutationObserver;
}

const guards: Guard[] = [];
let listening = false;

function reset(g: Guard): void {
  for (const el of g.touched) {
    el.style.removeProperty("max-height");
    el.style.removeProperty("overflow");
    el.style.removeProperty("visibility");
    el.style.removeProperty("margin-bottom");
  }
  g.touched.clear();
}

function apply(g: Guard): void {
  const panel = g.panel;
  g.mo.disconnect();
  reset(g);
  const cs = getComputedStyle(panel);
  if (panel.hidden || cs.display === "none" || cs.visibility === "hidden") {
    observe(g);
    return;
  }
  const pr = panel.getBoundingClientRect();
  const limit = pr.bottom - (parseFloat(cs.borderBottomWidth) || 0);
  const top = pr.top + (parseFloat(cs.borderTopWidth) || 0);
  const walk = (el: HTMLElement): void => {
    for (const child of el.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.hidden) continue;
      const r = child.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.top >= limit - 0.5 || r.bottom <= top + 0.5) {
        // entirely outside the panel's box: invisible anyway
        child.style.setProperty("visibility", "hidden");
        g.touched.add(child);
        continue;
      }
      if (r.bottom > limit + 0.5) {
        const ccs = getComputedStyle(child);
        if (ccs.display === "inline") {
          child.style.setProperty("visibility", "hidden");
          g.touched.add(child);
          continue;
        }
        // Truncate to the panel edge, and give the removed height back as margin so the
        // scroll range of the container is unchanged (the user can still scroll to it).
        const keep = Math.max(0, limit - r.top);
        const cut = r.height - keep;
        child.style.setProperty("max-height", `${keep}px`);
        child.style.setProperty("overflow", "hidden");
        child.style.setProperty("margin-bottom", `${(parseFloat(ccs.marginBottom) || 0) + cut}px`);
        g.touched.add(child);
      }
      walk(child);
    }
  };
  walk(panel);
  observe(g);
}

function observe(g: Guard): void {
  g.mo.observe(g.panel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class", "style", "data-mode"] });
}

function schedule(g: Guard): void {
  if (g.scheduled) return;
  g.scheduled = true;
  requestAnimationFrame(() => {
    g.scheduled = false;
    apply(g);
  });
}

/** Keep every descendant of `panel` inside the panel's own box. */
export function guardOverflow(panel: HTMLElement): void {
  const g: Guard = { panel, touched: new Set(), scheduled: false, mo: new MutationObserver(() => schedule(g)) };
  guards.push(g);
  panel.addEventListener("scroll", () => schedule(g), { capture: true, passive: true });
  panel.addEventListener("transitionend", () => schedule(g));
  panel.addEventListener("animationend", () => schedule(g));
  new ResizeObserver(() => schedule(g)).observe(panel);
  if (!listening) {
    listening = true;
    window.addEventListener("resize", () => guards.forEach(schedule));
    window.addEventListener("orientationchange", () => setTimeout(() => guards.forEach(schedule), 80));
  }
  observe(g);
  schedule(g);
}

/** Re-run every guard now (after a layout change the observers cannot see, e.g. a body class toggle). */
export function refreshGuards(): void {
  guards.forEach(schedule);
}
