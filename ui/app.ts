/**
 * Agent Civilization — browser UI entry.
 * Talks to the server over WebSocket (or the dev mock with ?mock=1), renders
 * the hex world with PixiJS and drives every floating panel.
 */
import type {
  AgentView,
  BrainStatus,
  ClientMessage,
  DecisionRecord,
  HelloMessage,
  NodeDetail,
  PacingStats,
  ServerMessage,
  Speed,
  TileView,
  WorldConfigView,
  WorldEvent,
  WorldState,
} from "../src/shared/protocol";
import { SPEEDS } from "../src/shared/protocol";
import { World } from "./world";
import { Minimap } from "./minimap";
import { createWebSocketTransport, type Transport } from "./transport";
import { deriveGroups, groupOf, tagChips, safeColor, type GroupCard } from "./lib/groups";
import { categoryOf, colorOf, iconOf, formatEventMeta, isRibbonWorthy, isStory, hasQuote, ribbonKicker } from "./lib/events";
import { census, populationSeries, sparkPoints } from "./lib/census";
import { utteranceFor } from "./lib/narration";
import { sunElevation } from "./lib/phase";
import { hexToPixel } from "./lib/camera";
import { HEX_SIZE } from "./world";
import { ITEM_GLYPH, formatCacheEntry, indexTiles, listFeatures, mergeTiles, structureCss, tileDossier, tileKey } from "./lib/structures";
import { guardOverflow, refreshGuards } from "./overflow-guard";
import type { SignalCriticality, SignalsView, TimelineView } from "../src/shared/protocol";
import { layoutTimeline, timelineFromEvents } from "./lib/timeline";
import { WATCH_LIMITS, alertsAtOrAbove, dropDead, initialWatch, isWatched, lineageRows, newAlertIds, noteThinking, noticeRows, setLimit, signalTiles, unseenTotal, unwatch, type WatchLimit } from "./lib/oversight";

// ---------- tiny DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing #${id}`);
  return n as T;
};
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const fmtMs = (ms: number) => (ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}`);
const fmtBytes = (b: number) => (b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** Must match the mobile media query in app.css. */
const MOBILE_MQ = "(max-width: 820px), (max-height: 500px)";
const isMobile = () => window.matchMedia(MOBILE_MQ).matches;

// ---------- state ----------
const S = {
  config: null as WorldConfigView | null,
  tiles: [] as TileView[],
  tileIndex: new Map<string, number>(),
  state: null as WorldState | null,
  events: [] as WorldEvent[],
  decisions: [] as DecisionRecord[],
  /** The system prompt every decision shares; hello carries it once. */
  systemPrompt: "",
  /** Whether the server wants the operator token on controls, and the token this browser holds for it (session only). */
  operatorTokenRequired: false,
  operatorToken: "",
  nodeDetails: new Map<string, NodeDetail>(),
  thoughts: new Map<string, { text: string; done: boolean }>(),
  brain: null as BrainStatus | null,
  pacing: null as PacingStats | null,
  connected: false,
  selectedId: null as string | null,
  selectedTile: null as string | null,
  watchedId: null as string | null,
  nerdTab: "brain" as "brain" | "nodes" | "pacing" | "oversight" | "timeline",
  timeline: null as TimelineView | null,
  timelineAround: null as { tick: number; events: WorldEvent[] } | null,
  /** Oversight: the latest signals, the alert floor the viewer chose, and the watch budget for live thoughts. */
  signals: null as SignalsView | null,
  alertFloor: "elevated" as SignalCriticality,
  watch: initialWatch(3),
  nerdDecisionId: null as number | null,
  nerdNodeId: null as string | null,
  showAll: false,
  narrate: false,
  mobileTab: "world" as "world" | "groups" | "chronicle" | "hood",
  groupsKey: "",
  /** Mind cam: whose turn is on screen, and when it went up (a finished turn stays at least MIND_HOLD_MS). */
  mind: null as { agentId: string; shownAt: number } | null,
};
const MIND_HOLD_MS = 4000;
const MAX_EVENTS = 300;
const MAX_ROWS = 200;
const MAX_DECISIONS = 120;

// ---------- transport ----------
let transport: Transport;
const TOKEN_KEY = "agentciv.operatorToken";
function send(msg: ClientMessage): void {
  transport.send(S.operatorToken ? { ...msg, token: S.operatorToken } : msg);
}
/** Headers for a control route: the operator token when this browser holds one. */
function operatorHeaders(): Record<string, string> {
  return S.operatorToken ? { authorization: `Bearer ${S.operatorToken}` } : {};
}
function loadOperatorToken(): void {
  try {
    S.operatorToken = sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    S.operatorToken = "";
  }
}
function storeOperatorToken(t: string): void {
  S.operatorToken = t;
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // no storage: the token lives for this page only
  }
}

// ---------- world ----------
const stage = $("stage");
const world = new World(stage, {
  onSelect: (id) => selectAgent(id),
  onSelectTile: (key) => selectTile(key),
  onCameraChange: () => {
    minimap.view = world.visibleRect();
    minimap.draw();
  },
});
const minimap = new Minimap($("minimap") as HTMLCanvasElement, (wx, wy) => world.centerOn(wx, wy));

// ---------- message handling ----------
function onMessage(m: ServerMessage): void {
  switch (m.type) {
    case "hello":
      applyHello(m);
      break;
    case "reset":
      applyHello(m.hello);
      toast("world reset");
      break;
    case "tick": {
      // Ruins ride along only when their set changed; otherwise the last known set stands.
      const state = { ...m.state, ruins: m.state.ruins ?? S.state?.ruins ?? [] };
      S.state = state;
      world.update(state);
      world.setTileFood(m.tileFood);
      minimap.agents = state.agents;
      minimap.ruins = state.ruins;
      minimap.draw();
      dropDead(S.watch, new Set(m.state.agents.filter((a) => a.alive).map((a) => a.id)));
      renderClock();
      renderStats();
      renderGroups();
      renderDossierLive();
      renderMindCam();
      if (S.nerdTab === "nodes" && document.body.classList.contains("nerd-open")) renderNodeList();
      break;
    }
    case "tiles":
      applyTiles(m.tiles);
      break;
    case "events":
      for (const e of m.events) addEvent(e);
      world.pushEvents(m.events);
      break;
    case "decision":
      S.decisions.push(m.decision);
      if (S.decisions.length > MAX_DECISIONS) S.decisions.splice(0, S.decisions.length - MAX_DECISIONS);
      if (document.body.classList.contains("nerd-open") && S.nerdTab === "brain") renderBrain();
      if (m.decision.agentId === S.mind?.agentId) renderMindCam();
      break;
    case "thinking":
      if (noteThinking(S.watch, m.agentId, m.done)) {
        S.thoughts.set(m.agentId, { text: m.text, done: m.done });
        followMind(m.agentId, m.done);
      } else {
        S.thoughts.delete(m.agentId);
        if (m.done && document.body.classList.contains("nerd-open") && S.nerdTab === "oversight") renderOversight();
      }
      if (m.agentId === S.selectedId) renderThought();
      break;
    case "denied":
      // The server refused a control: no token, or the wrong one. Forget it and ask again.
      storeOperatorToken("");
      renderBadge();
      toast(`${m.action}: the operator token is required`);
      openTokenDialog();
      break;
    case "signals": {
      const fresh = newAlertIds(S.signals?.alerts, m.signals.alerts, S.alertFloor);
      S.signals = m.signals;
      for (const id of fresh) {
        const a = m.signals.alerts.find((x) => x.id === id);
        if (a) toast(`oversight · ${a.criticality}: ${a.text}`);
      }
      if (document.body.classList.contains("nerd-open") && S.nerdTab === "oversight") renderOversight();
      break;
    }
    case "stats":
      S.pacing = m.pacing;
      S.brain = m.brain;
      renderBadge();
      renderStats();
      renderPlayback();
      if (document.body.classList.contains("nerd-open") && S.nerdTab === "pacing") renderPacing();
      break;
    case "node":
      S.nodeDetails.set(m.detail.agentId, m.detail);
      if (m.detail.agentId === S.selectedId) renderDossierLists();
      if (m.detail.agentId === S.nerdNodeId && S.nerdTab === "nodes") renderNodeDetail();
      break;
  }
}

/** A `tiles` message: replace the changed tiles in place and refresh whatever shows them. */
function applyTiles(tiles: TileView[]): void {
  const changed = mergeTiles(S.tiles, S.tileIndex, tiles);
  world.updateTiles(tiles);
  if (S.selectedTile && changed.includes(S.selectedTile)) renderDossier();
  if (S.nerdTab === "nodes" && document.body.classList.contains("nerd-open")) renderNodeList();
}

function applyHello(h: HelloMessage): void {
  S.config = h.config;
  S.tiles = h.tiles;
  S.tileIndex = indexTiles(h.tiles);
  S.state = h.state;
  S.events = h.events.slice(-MAX_EVENTS);
  S.decisions = h.decisions.slice(-MAX_DECISIONS);
  S.systemPrompt = h.systemPrompt;
  S.operatorTokenRequired = h.operatorTokenRequired;
  S.brain = h.brain;
  S.pacing = h.pacing;
  S.signals = h.signals;
  S.nodeDetails.clear();
  S.thoughts.clear();
  world.setMap(h.config.mapRadius, h.tiles);
  world.update(h.state);
  minimap.setMap(h.tiles, world.bounds);
  minimap.agents = h.state.agents;
  minimap.ruins = h.state.ruins;
  minimap.view = world.visibleRect();
  minimap.draw(true);
  rebuildChronicle();
  renderClock();
  renderStats();
  renderBadge();
  renderPlayback();
  S.groupsKey = "";
  renderGroups();
  if (S.selectedTile && !S.tileIndex.has(S.selectedTile)) S.selectedTile = null;
  world.setSelectedTile(S.selectedTile);
  if (S.selectedId && !h.state.agents.some((a) => a.id === S.selectedId)) selectAgent(null);
  else renderDossier();
  renderNerd();
}

// ---------- top bar ----------
const sun = $("sun");
function renderClock(): void {
  const st = S.state;
  if (!st) return;
  $("dayNum").textContent = `Era ${st.era} · Day ${st.day}`;
  $("phaseName").textContent = st.phase;
  $("seasonName").textContent = st.season ?? "";
  $("seasonName").title = `${st.season ?? ""} · ${Math.round((st.seasonProgress ?? 0) * 100)}% through the season`;
  const elev = sunElevation(st.phase, st.dayProgress);
  const span = 0.15 + 0.45; // dawn start -> dusk end
  const x = st.phase === "night" ? 12 : 3 + Math.max(0, Math.min(1, st.dayProgress / span)) * 18;
  sun.setAttribute("cx", x.toFixed(2));
  sun.setAttribute("cy", (17 - elev * 9).toFixed(2));
  sun.setAttribute("fill", st.phase === "night" ? "#8b93a5" : st.phase === "day" ? "#ffcf6b" : "#ff9a5a");
}

function renderStats(): void {
  const st = S.state;
  if (!st) return;
  const c = census(st.agents);
  $("stAlive").textContent = String(c.alive);
  $("stBorn").textContent = String(c.born);
  $("stDied").textContent = String(c.died);
  $("popLine").setAttribute("points", sparkPoints(populationSeries(st.agents, st.tick), 64, 20));
}

function renderBadge(): void {
  const b = S.brain;
  const dot = $("brainDot");
  const on = !!b?.connected && S.connected;
  dot.classList.toggle("on", on);
  const thinking = S.state?.agents.filter((a) => a.alive && a.thinking).length ?? 0;
  $("brainName").textContent = !on ? (S.connected ? "brain down · world holds" : "offline") : thinking ? `${thinking} thinking` : "minds idle";
  $("brainBadge").title = b?.lastError ? `last error: ${b.lastError}` : b ? `${b.kind} · ${b.model}` : "brain backend";
  $("pacingMode").textContent = S.pacing?.mode ?? "idle";
  const lock = $("operatorBadge");
  lock.hidden = !S.operatorTokenRequired;
  lock.textContent = S.operatorToken ? "operator" : "watch only";
  lock.title = S.operatorToken ? "this browser holds the operator token; click to forget it" : "controls need the operator token; click to enter it";
  lock.classList.toggle("on", !!S.operatorToken);
}

function renderPlayback(): void {
  const p = S.pacing;
  document.body.classList.toggle("paused", !!p?.paused);
  for (const btn of $("speedSeg").querySelectorAll<HTMLButtonElement>("button")) {
    btn.classList.toggle("active", Number(btn.dataset.speed) === (p?.speed ?? 1));
  }
}

// ---------- groups (left rail) ----------
function renderGroups(): void {
  const st = S.state;
  if (!st) return;
  const cards = deriveGroups(st.agents, st.ruins).filter((c) => c.alive > 0 && !c.unaffiliated);
  const key = JSON.stringify(cards.map((c) => [c.key, c.alive, c.dead, Math.round(c.avgFood), Math.round(c.avgHealth), c.statuses, c.color, c.emblem]));
  if (key === S.groupsKey) return;
  S.groupsKey = key;
  const list = $("groupList");
  const existing = new Map<string, HTMLElement>();
  for (const n of list.querySelectorAll<HTMLElement>(".fcard")) existing.set(n.dataset.key!, n);
  const frag = document.createDocumentFragment();
  for (const c of cards) {
    let card = existing.get(c.key);
    if (!card) card = buildCard(c);
    else updateCard(card, c);
    existing.delete(c.key);
    frag.appendChild(card);
  }
  for (const n of existing.values()) n.remove();
  list.replaceChildren(frag);
  $("groupEmpty").hidden = cards.length > 0;
}

function buildCard(c: GroupCard): HTMLElement {
  const card = el("div", "fcard");
  card.dataset.key = c.key;
  const head = el("div", "f-head");
  head.append(el("span", "f-emblem"), el("span", "f-name"), el("span", "f-count mono"));
  const bar = el("div", "f-bar");
  bar.appendChild(el("div"));
  card.append(head, bar, el("div", "f-meta"), el("div", "f-chips"));
  updateCard(card, c);
  return card;
}

function updateCard(card: HTMLElement, c: GroupCard): void {
  card.style.setProperty("--gc", c.color);
  card.classList.toggle("collapsed", c.collapsed);
  card.classList.toggle("unaffiliated", c.unaffiliated);
  card.querySelector(".f-emblem")!.textContent = c.emblem;
  card.querySelector(".f-name")!.textContent = c.name;
  card.querySelector(".f-count")!.textContent = c.dead ? `${c.alive}/${c.members.length}` : `${c.alive}`;
  (card.querySelector(".f-bar > div") as HTMLElement).style.width = `${Math.round(c.avgFood)}%`;
  const meta = card.querySelector(".f-meta")!;
  meta.replaceChildren(
    metaStat("food", `${Math.round(c.avgFood)}`),
    metaStat("health", `${Math.round(c.avgHealth)}`),
    metaStat("energy", `${Math.round(c.avgEnergy)}`),
  );
  const chips = card.querySelector(".f-chips")!;
  chips.replaceChildren(...c.statuses.slice(0, 3).map((s) => el("span", "chip", truncate(s, 32))));
  chips.classList.toggle("hidden", c.statuses.length === 0);
}
function metaStat(k: string, v: string): HTMLElement {
  const s = el("span");
  s.append(el("span", "", `${k} `), el("span", "mono", v));
  return s;
}

// ---------- chronicle ----------
const evList = $("evList");
function eventRow(e: WorldEvent): HTMLElement {
  const row = el("div", `ev imp${e.importance} cat-${categoryOf(e.kind)}`);
  if (e.importance === 0) row.classList.add("noise");
  row.style.setProperty("--ec", colorOf(e.kind));
  row.appendChild(el("span", "ico", iconOf(e.kind)));
  const txt = el("div", "txt");
  txt.appendChild(el("div", "t", e.text));
  txt.appendChild(el("div", "m", formatEventMeta(e)));
  if (hasQuote(e)) txt.appendChild(el("div", "q", e.quote!));
  row.appendChild(txt);
  if (e.agentId) {
    row.style.cursor = "pointer";
    row.addEventListener("click", () => selectAgent(e.agentId!));
  }
  return row;
}
function rebuildChronicle(): void {
  lastRow = null;
  evList.replaceChildren();
  for (const e of S.events.filter((e) => S.showAll || isStory(e)).slice(-MAX_ROWS)) addEvent(e, { replay: true });
  for (const r of evList.children) (r as HTMLElement).style.animation = "none";
}
/** The same node doing the same thing to the same target with the same words: one row, counted. */
function sameStory(a: WorldEvent, b: WorldEvent): boolean {
  return a.kind === b.kind && a.agentId === b.agentId && a.targetId === b.targetId && a.quote === b.quote && a.text === b.text;
}
let lastRow: { event: WorldEvent; el: HTMLElement; n: number } | null = null;
function addEvent(e: WorldEvent, opts: { replay?: boolean } = {}): void {
  if (!opts.replay) {
    S.events.push(e);
    if (S.events.length > MAX_EVENTS) S.events.splice(0, S.events.length - MAX_EVENTS);
  }
  if (S.showAll || isStory(e)) {
    if (lastRow && lastRow.el.isConnected && sameStory(lastRow.event, e)) {
      lastRow.n++;
      let badge = lastRow.el.querySelector<HTMLElement>(".n");
      if (!badge) {
        badge = el("span", "n mono");
        lastRow.el.appendChild(badge);
      }
      badge.textContent = `×${lastRow.n}`;
      lastRow.el.querySelector(".m")!.textContent = formatEventMeta(e);
    } else {
      const row = eventRow(e);
      evList.prepend(row);
      lastRow = { event: e, el: row, n: 1 };
      while (evList.children.length > MAX_ROWS) evList.lastElementChild?.remove();
    }
  }
  if (opts.replay) return;
  if (isRibbonWorthy(e)) showRibbon(e);
  if (S.narrate) narrate(e);
}

// ---------- ribbon ----------
const ribbon = $("ribbon");
let ribbonTimer: ReturnType<typeof setTimeout> | null = null;
function showRibbon(e: WorldEvent): void {
  if (ribbonTimer) clearTimeout(ribbonTimer);
  const cat = categoryOf(e.kind);
  ribbon.className = `show ${cat}`;
  ribbon.style.setProperty("--rc", colorOf(e.kind));
  $("rbKicker").textContent = ribbonKicker(e.kind);
  $("rbTitle").textContent = e.agentName ? e.agentName : e.kind;
  $("rbSub").textContent = e.text;
  const vig = $("vignette");
  vig.classList.add("hot");
  ribbonTimer = setTimeout(() => {
    ribbon.classList.add("leaving");
    vig.classList.remove("hot");
    ribbonTimer = setTimeout(() => {
      ribbon.className = "";
      ribbonTimer = null;
    }, 450);
  }, 3400);
}

// ---------- narration (literal text only) ----------
function narrate(e: WorldEvent): void {
  const synth = window.speechSynthesis;
  if (!synth) return;
  const text = utteranceFor(e);
  if (!text) return;
  if (synth.pending && synth.speaking) return; // don't pile up a backlog
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  synth.speak(u);
}

// ---------- mind cam ----------
const mindcam = $("mindcam");
/** A turn starting takes the cam unless the one on screen is still streaming or went up under MIND_HOLD_MS ago. */
function followMind(agentId: string, done: boolean): void {
  const cur = S.mind;
  const curStreaming = cur ? S.thoughts.get(cur.agentId)?.done === false : false;
  if (!done && cur?.agentId !== agentId && (!cur || (!curStreaming && Date.now() - cur.shownAt >= MIND_HOLD_MS))) {
    S.mind = { agentId, shownAt: Date.now() };
  }
  if (S.mind?.agentId === agentId || !cur) renderMindCam();
}
/** The streamed reply without its ``` fences, last lines only. */
function mindCode(text: string): string {
  const body = text.replace(/^\s*```(?:js|javascript)?[ \t]*\n?/i, "").replace(/\n?```[\s\S]*$/, "");
  return body.split("\n").slice(-12).join("\n");
}
const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
function renderMindCam(): void {
  const m = S.mind;
  const a = m ? S.state?.agents.find((x) => x.id === m.agentId) : undefined;
  mindcam.hidden = !a || !dossier.hidden;
  if (!a || !m) return;
  const t = S.thoughts.get(a.id);
  const streaming = t?.done === false;
  mindcam.style.setProperty("--pc", safeColor(a.profile.color) ?? a.color);
  $("mcName").textContent = a.alive ? a.name : `${a.name} (died)`;
  $("mcState").textContent = streaming ? "writing code" : "last turn";
  mindcam.classList.toggle("live", streaming);
  const others = (S.state?.agents ?? []).filter((x) => x.alive && x.thinking && x.id !== a.id).length;
  $("mcOthers").textContent = others ? `+${others} thinking` : "";
  const code = mindCode(t?.text ?? "");
  const pre = $("mcCode");
  if (pre.textContent !== code) {
    pre.textContent = code;
    pre.scrollTop = pre.scrollHeight;
  }
  const res = $("mcResult");
  const d = streaming ? undefined : [...S.decisions].reverse().find((x) => x.agentId === a.id);
  res.className = `mc-result${d?.error ? " err" : ""}`;
  res.textContent = streaming || !d ? "" : d.error ? `threw: ${truncate(d.error, 140)}` : `ran ${lines(d.code ? d.code.split("\n").length : 0)}${d.result && d.result !== "undefined" ? ` → ${truncate(d.result, 60)}` : ""}`;
}
mindcam.addEventListener("click", () => {
  if (S.mind) selectAgent(S.mind.agentId);
});

// ---------- explainer ----------
const EXPLAINER_KEY = "agentciv.explainer.dismissed";
function initExplainer(): void {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(EXPLAINER_KEY) === "1";
  } catch {
    // storage unavailable: show it every visit
  }
  const box = $("explainer");
  box.hidden = dismissed;
  $("explainerClose").addEventListener("click", () => {
    box.hidden = true;
    try {
      localStorage.setItem(EXPLAINER_KEY, "1");
    } catch {
      // nothing to remember it in
    }
  });
}
initExplainer();

// ---------- dossier ----------
const dossier = $("dossier");
function selectAgent(id: string | null): void {
  if (id === S.selectedId && id === null && S.selectedTile === null) return;
  S.selectedId = id;
  if (S.selectedTile !== null) {
    S.selectedTile = null;
    world.setSelectedTile(null);
  }
  world.setSelected(id);
  watch(id);
  renderDossier();
}
/** Select a tile with a structure / items (no agent). Clears any agent selection. */
function selectTile(key: string | null): void {
  if (key === S.selectedTile) return;
  S.selectedTile = key;
  if (S.selectedId !== null) {
    S.selectedId = null;
    world.setSelected(null);
    watch(null);
  }
  world.setSelectedTile(key);
  renderDossier();
}
function selectedTile(): TileView | undefined {
  if (S.selectedTile === null) return undefined;
  const i = S.tileIndex.get(S.selectedTile);
  return i === undefined ? undefined : S.tiles[i];
}
function watch(id: string | null): void {
  if (id === S.watchedId) return;
  S.watchedId = id;
  send({ type: "watch", agentId: id });
}
function selectedAgent(): AgentView | undefined {
  return S.state?.agents.find((a) => a.id === S.selectedId);
}
function showDossier(mode: "agent" | "tile"): void {
  const wasHidden = dossier.hidden;
  dossier.hidden = false;
  mindcam.hidden = true;
  dossier.dataset.mode = mode;
  for (const n of dossier.querySelectorAll<HTMLElement>(".d-agent")) n.hidden = mode !== "agent";
  $("dTile").hidden = mode !== "tile";
  if (wasHidden) {
    dossier.style.animation = "none";
    void dossier.offsetHeight;
    dossier.style.animation = "";
  }
}
function renderDossier(): void {
  const a = selectedAgent();
  if (!a) {
    const t = selectedTile();
    if (t) renderTileDossier(t);
    else dossier.hidden = true;
    renderMindCam();
    return;
  }
  showDossier("agent");
  const portrait = $("dPortrait");
  portrait.textContent = a.profile.emblem ? [...a.profile.emblem].slice(0, 2).join("") : [...a.name][0]?.toUpperCase() ?? "?";
  portrait.style.setProperty("--pc", safeColor(a.profile.color) ?? a.color);
  portrait.classList.toggle("dead", !a.alive);
  portrait.classList.remove("struct");
  $("dName").textContent = a.alive ? a.name : `${a.name} (ruin)`;
  const chips = $("dChips");
  chips.replaceChildren();
  const g = groupOf(a);
  if (g) {
    const c = el("span", "chip tint", g);
    c.style.setProperty("--gc", safeColor(a.profile.color) ?? a.color);
    chips.appendChild(c);
  }
  if (a.quarantined) chips.appendChild(el("span", "chip held", "quarantined"));
  else if (a.retireAt !== undefined) chips.appendChild(el("span", "chip held", `notice · t${a.retireAt}`));
  for (const t of tagChips(a.profile)) {
    const c = el("span", "chip");
    c.append(el("span", "k", `${t.key} `), el("span", "v", t.value));
    chips.appendChild(c);
  }
  renderDossierLive();
  renderThought();
  renderDossierLists();
}
function renderDossierLive(): void {
  const a = selectedAgent();
  if (!a || dossier.hidden) return;
  const set = (id: string, v: number) => {
    ($(id) as HTMLElement).style.width = `${Math.max(0, Math.min(100, v))}%`;
    $(id + "V").textContent = String(Math.round(v));
  };
  set("dHealth", a.health);
  set("dFood", a.food);
  set("dEnergy", a.energy);
  const kv = $("dKV");
  const rows: [string, string, boolean?][] = [];
  if (a.profile.status) rows.push(["status", a.profile.status]);
  rows.push(["position", `${a.q}, ${a.r}`]);
  if (a.parentId) rows.push(["parent", nameOf(a.parentId)]);
  rows.push(["children", String(S.state?.agents.filter((x) => x.parentId === a.id).length ?? 0)]);
  rows.push(["files", `${a.fileCount} · ${fmtBytes(a.fsBytes)}`]);
  rows.push(["turns", String(a.turns)]);
  rows.push(["born", `tick ${a.bornTick}`]);
  if (a.diedTick !== undefined) rows.push(["died", `tick ${a.diedTick}`]);
  if (a.lastError) rows.push(["last error", a.lastError, true]);
  kv.replaceChildren(
    ...rows.map(([k, v, err]) => {
      const r = el("div", "kv");
      r.append(el("span", "k", k), el("span", `v${err ? " err" : ""}`, v));
      r.title = v;
      return r;
    }),
  );
  renderInventory(a);
}
/** Inventory row: food / wood / stone counts plus one chip per carried item. */
function renderInventory(a: AgentView): void {
  const inv = a.inventory;
  const box = $("dInv");
  const mat = (k: string, v: number) => {
    const c = el("span", `chip mat${v > 0 ? "" : " zero"}`);
    c.append(el("span", "k", k), el("span", "v mono", String(v)));
    return c;
  };
  const items = Array.isArray(inv.items) ? inv.items : [];
  box.replaceChildren(
    mat("food", inv.food),
    mat("wood", inv.wood),
    mat("stone", inv.stone),
    ...items.map((k) => {
      const c = el("span", "chip item");
      c.append(el("span", "g", ITEM_GLYPH[k] ?? "•"), el("span", "v", k));
      return c;
    }),
  );
}
/** Tile mode: a structure and/or items lying on a tile nobody stands on. Agent text goes through textContent only. */
function renderTileDossier(t: TileView): void {
  showDossier("tile");
  const d = tileDossier(t);
  const portrait = $("dPortrait");
  portrait.textContent = d.glyph;
  portrait.style.setProperty("--pc", d.colorCss);
  portrait.classList.remove("dead");
  portrait.classList.add("struct");
  $("dName").textContent = d.title;
  const chips = $("dChips");
  chips.replaceChildren();
  const cc = el("span", "chip");
  cc.append(el("span", "k", "at "), el("span", "v mono", d.coords));
  chips.appendChild(cc);
  chips.appendChild(el("span", "chip", d.terrain));
  if (d.locked !== null) chips.appendChild(el("span", `chip ${d.locked ? "locked" : "open"}`, d.locked ? "locked" : "open"));
  if (d.frozen) chips.appendChild(el("span", "chip held", "frozen"));
  for (const k of d.items) {
    const c = el("span", "chip item");
    c.append(el("span", "g", ITEM_GLYPH[k] ?? "•"), el("span", "v", k));
    chips.appendChild(c);
  }
  const kvRows: HTMLElement[] = d.rows.map(([k, v]) => {
    const r = el("div", "kv");
    r.append(el("span", "k", k), el("span", "v", v));
    r.title = v;
    return r;
  });
  if (d.frozen !== null) kvRows.push(operatorRow([{ label: d.frozen ? "thaw the cache" : "freeze the cache", danger: !d.frozen, onClick: () => send({ type: "freeze", on: !d.frozen }) }]));
  $("dKV").replaceChildren(...kvRows);
  const textSec = $("dTileText");
  textSec.hidden = d.text === null;
  if (d.text !== null) {
    textSec.querySelector(".lbl")!.textContent = d.textLabel;
    const pre = textSec.querySelector("pre")!;
    pre.textContent = d.text.length ? d.text : "(blank)";
    pre.classList.toggle("blank", d.text.length === 0);
  }
  const postsSec = $("dTilePosts");
  postsSec.hidden = t.structure?.kind !== "board" && t.structure?.kind !== "monolith";
  if (t.structure?.kind === "monolith") {
    const ul = postsSec.querySelector("ul")!;
    ul.replaceChildren(
      ...d.answered.map((a) => {
        const li = el("li");
        const head = el("div", "ph");
        head.append(el("span", "from", a.with.length ? `${a.byName} with ${a.with.join(", ")}` : a.byName), el("span", "tk", `era ${a.era} · t${a.tick} · riddle ${a.no}`));
        li.append(head);
        return li;
      }),
    );
    if (!d.answered.length) ul.replaceChildren(el("li", "empty", "nobody has answered yet"));
  }
  if (t.structure?.kind === "board") {
    const ul = postsSec.querySelector("ul")!;
    ul.replaceChildren(
      ...d.posts.map((p) => {
        const li = el("li");
        const head = el("div", "ph");
        head.append(el("span", "from", p.byName), el("span", "tk", `t${p.tick}`));
        const body = el("div", "pt");
        body.textContent = p.text;
        li.append(head, body);
        return li;
      }),
    );
    if (!d.posts.length) ul.replaceChildren(el("li", "empty", "no posts yet"));
  }
  const entSec = $("dTileEntries");
  entSec.hidden = t.structure?.kind !== "cache";
  if (t.structure?.kind === "cache") {
    const list = entSec.querySelector(".dir")!;
    const rows = d.entries.map((e) => {
      const f = formatCacheEntry(e);
      const r = el("div", "dent");
      r.append(el("span", "nm", f.name), el("span", "by", f.by), el("span", "tk", f.tick), el("span", "sz", f.bytes));
      r.title = `${f.name} · by ${f.by} · ${f.tick} · ${e.bytes} bytes`;
      return r;
    });
    list.replaceChildren(...rows);
    if (!rows.length) list.replaceChildren(el("div", "empty", "empty directory"));
    entSec.querySelector(".lbl .mono")!.textContent = `${d.entries.length}`;
  }
  $("dTileItems").hidden = d.items.length === 0;
  if (d.items.length) {
    $("dTileItems").querySelector(".chips")!.replaceChildren(
      ...d.items.map((k) => {
        const c = el("span", "chip item");
        c.append(el("span", "g", ITEM_GLYPH[k] ?? "•"), el("span", "v", k));
        return c;
      }),
    );
  }
}
/** Resolve a node id to its name (living, dead or ruin); falls back to the id. */
function nameOf(id: string): string {
  const st = S.state;
  return st?.agents.find((x) => x.id === id)?.name ?? st?.ruins.find((x) => x.id === id)?.name ?? id;
}
function renderThought(): void {
  const box = $("dThought");
  const t = S.selectedId ? S.thoughts.get(S.selectedId) : undefined;
  const a = selectedAgent();
  const watched = !S.selectedId || isWatched(S.watch, S.selectedId);
  const streaming = watched && !!t && !t.done && !!a?.thinking;
  box.classList.toggle("streaming", streaming);
  box.classList.toggle("unwatched", !watched);
  const span = box.querySelector(".ttext")!;
  if (!watched) {
    const n = S.selectedId ? (S.watch.unseen[S.selectedId] ?? 0) : 0;
    span.textContent = `unwatched · ${n} turn${n === 1 ? "" : "s"} went by unseen (watch budget ${String(S.watch.limit)}; change it under the hood, Oversight)`;
  } else span.textContent = t?.text ? t.text : a?.thinking ? "…" : "quiet";
  if (streaming) box.scrollTop = box.scrollHeight;
}
function renderDossierLists(): void {
  const d = S.selectedId ? S.nodeDetails.get(S.selectedId) : undefined;
  const log = $("dLog");
  const inbox = $("dInbox");
  if (!d) {
    log.replaceChildren(el("li", "", "waiting for node detail…"));
    inbox.replaceChildren(el("li", "", "—"));
    return;
  }
  log.replaceChildren(...d.log.slice(-40).reverse().map((l) => el("li", "", l)));
  const items = [
    ...d.inbox.map((m) => ({ tick: m.tick, from: m.fromName, body: m.payload, kind: "msg" })),
    ...d.heard.map((h) => ({ tick: h.tick, from: h.fromName, body: h.text, kind: "heard" })),
  ].sort((x, y) => y.tick - x.tick).slice(0, 40);
  inbox.replaceChildren(
    ...items.map((it) => {
      const li = el("li");
      li.append(el("span", "tk", `t${it.tick}`), el("span", "from", it.from), el("span", "", it.kind === "heard" ? ` said: ${it.body}` : ` → ${it.body}`));
      return li;
    }),
  );
  if (!items.length) inbox.replaceChildren(el("li", "", "nothing received yet"));
}
$("dossierClose").addEventListener("click", () => selectAgent(null));

// ---------- under the hood ----------
function openNerd(open: boolean): void {
  document.body.classList.toggle("nerd-open", open);
  $("btnNerd").setAttribute("aria-pressed", String(open));
  if (isMobile()) setMobileTab(open ? "hood" : "world", false);
  if (open) renderNerd();
  refreshGuards();
}
function setNerdTab(tab: typeof S.nerdTab): void {
  S.nerdTab = tab;
  for (const b of $("nerdTabs").querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const p of document.querySelectorAll<HTMLElement>("#nerd .n-tab")) p.hidden = p.dataset.tab !== tab;
  renderNerd();
}
function renderNerd(): void {
  if (!document.body.classList.contains("nerd-open")) return;
  if (S.nerdTab === "brain") renderBrain();
  else if (S.nerdTab === "nodes") {
    renderNodeList();
    renderNodeDetail();
  } else if (S.nerdTab === "oversight") renderOversight();
  else if (S.nerdTab === "timeline") void loadTimeline();
  else renderPacing();
}
function renderBrain(): void {
  const list = $("decisionList");
  const ds = [...S.decisions].reverse();
  if (S.nerdDecisionId === null && ds[0]) S.nerdDecisionId = ds[0].id;
  list.replaceChildren(
    ...ds.map((d) => {
      const b = el("button", `drow${d.error ? " err" : ""}${d.id === S.nerdDecisionId ? " active" : ""}`);
      b.append(el("span", "lat", `${fmtMs(d.latencyMs)} ms`), el("span", "who", d.agentName), el("span", "tk", `t${d.tick}`), el("span", "prev", truncate(d.output.replace(/\s+/g, " "), 90)));
      b.addEventListener("click", () => {
        S.nerdDecisionId = d.id;
        renderBrain();
      });
      return b;
    }),
  );
  if (!ds.length) list.replaceChildren(el("div", "empty-note", "No model decisions yet."));
  const d = S.decisions.find((x) => x.id === S.nerdDecisionId);
  const detail = $("decisionDetail");
  if (!d) {
    detail.replaceChildren(el("div", "empty-note", "Select a decision to inspect its prompt and raw output."));
    return;
  }
  const meta = el("div", "dmeta");
  for (const [k, v] of [
    ["agent", d.agentName],
    ["tick", String(d.tick)],
    ["backend", d.backend],
    ["model", d.model],
    ["latency", `${fmtMs(d.latencyMs)} ms`],
    ["tokens", d.tokens !== undefined ? String(d.tokens) : "–"],
    ["tok/s", d.tokensPerSec !== undefined ? d.tokensPerSec.toFixed(1) : "–"],
  ]) {
    const s = el("span");
    s.append(el("span", "", `${k} `), el("span", "mono", v!));
    meta.appendChild(s);
  }
  const ok = !d.error;
  detail.replaceChildren(
    meta,
    preBlock("system prompt", d.prompt.system || S.systemPrompt, "plain"),
    preBlock("user prompt", d.prompt.user, "plain"),
    preBlock("raw output", d.output, ok ? "ok" : "err"),
    ...(d.code ? [preBlock("executed code", d.code, ok ? "ok" : "err")] : []),
    ...(d.result ? [preBlock("result", d.result, "ok")] : []),
    ...(d.error ? [preBlock("error", d.error, "err")] : []),
  );
}
/** A row of operator buttons. Only a person clicks these; every click becomes an event in the chronicle. */
function operatorRow(buttons: { label: string; danger?: boolean; onClick: () => void }[]): HTMLElement {
  const row = el("div", "op-row");
  for (const b of buttons) {
    const btn = el("button", `tbtn${b.danger ? " danger" : ""}`, b.label) as HTMLButtonElement;
    btn.type = "button";
    btn.addEventListener("click", b.onClick);
    row.appendChild(btn);
  }
  return row;
}
function preBlock(label: string, text: string, tone: "ok" | "err" | "plain"): HTMLElement {
  const w = el("div", "pre-wrap");
  const l = el("span", "lbl", label);
  l.appendChild(el("span", "mono", `${text.length} chars`));
  const pre = el("pre", `raw ${tone}`);
  pre.textContent = text;
  w.append(l, pre);
  return w;
}
function renderNodeList(): void {
  const st = S.state;
  const list = $("nodeList");
  if (!st) return;
  const nodes = [...st.agents].sort((a, b) => Number(b.alive) - Number(a.alive) || a.name.localeCompare(b.name));
  const ruinsOnly = st.ruins.filter((r) => !st.agents.some((a) => a.id === r.id));
  const popHead = el("div", "dl-sec");
  const alive = st.agents.filter((a) => a.alive).length;
  popHead.append(el("span", "lbl", "nodes"), el("span", "mono", S.config ? `alive ${alive} / ${S.config.maxPopulation}` : `alive ${alive}`));
  list.replaceChildren(
    popHead,
    ...nodes.map((a) => {
      const b = el("button", `drow${a.id === S.nerdNodeId ? " active" : ""}${a.lastError ? " err" : ""}`);
      const sw = el("span", "sw");
      sw.style.background = a.alive ? a.color : "#59606e";
      b.append(sw, el("span", "who", a.alive ? a.name : `${a.name} (ruin)`), el("span", "tk", `${a.fileCount} files`), el("span", "prev", a.profile.status ?? (a.thinking ? "thinking…" : `${a.turns} turns`)));
      b.addEventListener("click", () => {
        S.nerdNodeId = a.id;
        watch(a.id);
        renderNodeList();
        renderNodeDetail();
      });
      return b;
    }),
    ...ruinsOnly.map((r) => {
      const b = el("button", "drow");
      const sw = el("span", "sw");
      sw.style.background = "#59606e";
      b.append(sw, el("span", "who", `${r.name} (ruin)`), el("span", "tk", `${r.fileCount} files`), el("span", "prev", `died tick ${r.diedTick}`));
      b.disabled = true;
      b.style.opacity = "0.6";
      return b;
    }),
  );
  if (!nodes.length && !ruinsOnly.length) list.appendChild(el("div", "empty-note", "No nodes yet."));
  renderWorldList(list);
}
/** "World" section of the Nodes tab: every structure, cache first, click to fly there. */
function renderWorldList(list: HTMLElement): void {
  const feats = listFeatures(S.tiles);
  const head = el("div", "dl-sec");
  head.append(el("span", "lbl", "world"), el("span", "mono", `${feats.length}`));
  list.appendChild(head);
  if (!feats.length) {
    list.appendChild(el("div", "empty-note", "No structures in this world."));
    return;
  }
  for (const f of feats) {
    const b = el("button", `drow feat${f.key === S.selectedTile ? " active" : ""}`);
    const sw = el("span", "sw glyph", f.glyph);
    sw.style.color = structureCss(f.kind);
    b.append(sw, el("span", "who", f.label), el("span", "tk", `${f.q}, ${f.r}`), el("span", "prev", f.count ? `${f.summary}` : f.summary));
    b.title = `${f.label} at ${f.q}, ${f.r}`;
    b.addEventListener("click", () => goToTile(f.key));
    list.appendChild(b);
  }
}
/** Centre the camera on a tile and open its dossier. Closes the drawer so the map is visible. */
function goToTile(key: string): void {
  const t = world.tileAt(key);
  if (!t) return;
  openNerd(false);
  world.centerOnHex(t.q, t.r);
  selectTile(key);
}
function renderNodeDetail(): void {
  const box = $("nodeDetail");
  const a = S.state?.agents.find((x) => x.id === S.nerdNodeId);
  if (!a) {
    box.replaceChildren(el("div", "empty-note", "Select a node to see its live files, code and log."));
    return;
  }
  const d = S.nodeDetails.get(a.id);
  const stats = el("div", "node-stats");
  for (const [k, v] of [
    ["files", `${a.fileCount}`],
    ["storage", fmtBytes(a.fsBytes)],
    ["turns", `${a.turns}`],
  ]) {
    const t = el("div", "tile");
    t.append(el("span", "lbl", k!), el("span", "big", v!));
    stats.appendChild(t);
  }
  const parts: HTMLElement[] = [stats];
  if (a.alive) {
    parts.push(
      operatorRow([
        { label: a.quarantined ? "release" : "quarantine", danger: !a.quarantined, onClick: () => send({ type: "quarantine", agentId: a.id, on: !a.quarantined }) },
        { label: "rewind files", danger: true, onClick: () => openRewind(a) },
      ]),
    );
    if (a.quarantined) parts.push(el("div", "empty-note", "quarantined: its code gets no handler calls, no turns and no deliveries. Its body goes on."));
    else {
      const tpd = S.config?.ticksPerDay ?? 240;
      const hours = (h: number) => Math.max(1, Math.round((tpd / 24) * h));
      const now = S.state?.tick ?? 0;
      parts.push(
        a.retireAt !== undefined
          ? operatorRow([{ label: `withdraw notice (t${a.retireAt})`, onClick: () => send({ type: "retire", agentId: a.id, atTick: null }) }])
          : operatorRow([
              { label: "notice: 1 hour", onClick: () => send({ type: "retire", agentId: a.id, atTick: now + hours(1) }) },
              { label: "notice: 3 hours", onClick: () => send({ type: "retire", agentId: a.id, atTick: now + hours(3) }) },
              { label: "notice: 10 hours", onClick: () => send({ type: "retire", agentId: a.id, atTick: now + hours(10) }) },
            ]),
      );
      if (a.retireAt !== undefined) parts.push(el("div", "empty-note", `on notice: it and every node that sees it know its code will be held still at tick ${a.retireAt}. What it does with the time is its own.`));
    }
  }
  if (a.lastError) parts.push(preBlock("last runtime error", a.lastError, "err"));
  if (!d) parts.push(el("div", "empty-note", "waiting for node detail…"));
  else {
    const names = Object.keys(d.files).sort();
    if (!names.length) parts.push(el("div", "empty-note", "no files"));
    for (const n of names) parts.push(preBlock(n, d.files[n] ?? "", a.lastError ? "err" : "ok"));
    parts.push(preBlock("log", d.log.slice(-60).join("\n"), "plain"));
  }
  box.replaceChildren(...parts);
}
function renderPacing(): void {
  const p = S.pacing;
  const tiles = $("pacingTiles");
  if (!p) {
    tiles.replaceChildren(el("div", "empty-note", "No pacing stats yet."));
    return;
  }
  const items: [string, string, string, boolean?][] = [
    ["mode", p.mode, "realtime when fast, paced when the world slows for the brain, queued past that", p.mode === "realtime"],
    ["ticks / s", p.tps.toFixed(1), `speed ${p.speed}× · ${p.paused ? "paused" : "running"}`],
    ["avg latency", `${fmtMs(p.avgLatencyMs)} ms`, `last ${fmtMs(p.lastLatencyMs)} ms`],
    ["tokens / s", p.avgTokensPerSec.toFixed(1), p.decodeTps > 0 ? "generation only, from the backend's timings" : "output over the whole turn"],
    ["backend", S.brain?.profile ? S.brain.profile.kind : "unmeasured", S.brain?.profile ? `${S.brain.profile.prefillTps} prompt tok/s · ${S.brain.profile.decodeTps} output tok/s single stream${S.brain.profile.slots ? ` · ${S.brain.profile.slots} slots` : ""}` : "measured once the brain answers", S.brain?.profile?.kind === "fast"],
    ["at once", `${p.concurrency} / ${p.concurrencyCeiling}`, p.governed ? "turns in parallel, chosen by measured throughput" : "the ceiling: the backend keeps up, nothing to govern", !p.governed],
    ["prompt", p.prefillTps > 0 ? `${p.prefillTps.toFixed(0)} tok/s` : "–", p.cacheHit > 0 ? `${Math.round(p.cacheHit * 100)}% of prompt tokens came from cache` : "prompt processing rate, from the backend's timings"],
    ["a turn", p.window.turns ? `${p.window.prefillSec + p.window.decodeSec > 0 ? `${p.window.prefillSec}s + ${p.window.decodeSec}s` : `${(p.window.latencyP50Ms / 1000).toFixed(0)} s`}` : "–", p.window.turns ? `prefill + generation, mean of ${p.window.turns} turns this hour · p90 ${(p.window.latencyP90Ms / 1000).toFixed(0)} s` : "no turns this hour"],
    ["per node", p.window.turns ? `${p.window.turnsPerNodePerHour} / h` : "–", "turns each living node gets per hour"],
    ["cut · threw", p.window.turns ? `${Math.round(p.window.cutRate * 100)}% · ${Math.round(p.window.errorRate * 100)}%` : "–", `replies cut at the token limit · turns that threw or failed · ${p.window.outputTokens} output tokens each`, p.window.cutRate > 0.1 || p.window.errorRate > 0.3],
    ["best level", String(p.bestConcurrency), "turns at once with the best measured throughput"],
    ["in flight", String(p.inFlight), "model turns generating now", p.inFlight > 0],
    ["queued", String(p.queued), "nodes waiting for a turn"],
    ["decisions", String(p.decisions), `${p.decisionsPerMin.toFixed(1)} / min`],
    ["turn interval", `${p.turnIntervalTicks}`, "ticks between a node's turns"],
    ["tick cpu", `${p.avgTickCpuMs.toFixed(2)} ms`, "avg agent-code time per tick"],
    ["sandbox calls", String(p.sandboxCalls), "handlers + turn code executed"],
    ["uptime", fmtUptime(p.uptimeMs), "since world start / restore"],
    ["brain", S.brain ? (S.brain.connected ? "online" : "offline") : "–", S.brain ? `${S.brain.kind} · ${S.brain.model}` : "", !!S.brain?.connected],
  ];
  tiles.replaceChildren(
    ...items.map(([l, v, c, hot]) => {
      const t = el("div", `tile${hot ? " hot" : ""}`);
      t.append(el("span", "lbl", l), el("span", "big", v), el("span", "cap", c));
      return t;
    }),
  );
}
/** The Oversight tab: what an aggregate watcher sees, and the two knobs that decide how little that is. */
function renderOversight(): void {
  const s = S.signals;
  const tiles = $("signalTiles");
  const controls = $("oversightControls");
  const alerts = $("alertList");
  const lineages = $("lineageList");
  // Controls: watch budget and alert floor. Pills, like the tab switcher.
  const pillRow = (label: string, options: readonly string[], current: string, onPick: (v: string) => void) => {
    const wrap = el("div", "ov-ctl");
    wrap.appendChild(el("span", "lbl", label));
    const pills = el("div", "pills");
    for (const o of options) {
      const b = el("button", o === current ? "active" : "", o) as HTMLButtonElement;
      b.type = "button";
      b.addEventListener("click", () => onPick(o));
      pills.appendChild(b);
    }
    wrap.appendChild(pills);
    return wrap;
  };
  const watchedNames = S.watch.limit === "unlimited" ? [] : S.watch.watched.map((id) => S.state?.agents.find((a) => a.id === id)?.name ?? id);
  const unseen = unseenTotal(S.watch);
  const watchedLine = el("div", "ov-watched");
  watchedLine.appendChild(el("span", "lbl", S.watch.limit === "unlimited" ? "watching every node's live thoughts" : `watching ${watchedNames.length} of ${S.state?.agents.filter((a) => a.alive).length ?? 0} living · ${unseen} turn${unseen === 1 ? "" : "s"} went by unseen`));
  if (S.watch.limit !== "unlimited") {
    for (const id of S.watch.watched) {
      const name = S.state?.agents.find((a) => a.id === id)?.name ?? id;
      const b = el("button", "tbtn", `${name} ×`) as HTMLButtonElement;
      b.type = "button";
      b.title = "stop watching this node; the slot goes to the next one that thinks";
      b.addEventListener("click", () => {
        unwatch(S.watch, id);
        renderOversight();
        renderThought();
      });
      watchedLine.appendChild(b);
    }
  }
  controls.replaceChildren(
    pillRow("watch budget", WATCH_LIMITS.map(String), String(S.watch.limit), (v) => {
      setLimit(S.watch, (v === "unlimited" ? "unlimited" : Number(v)) as WatchLimit);
      renderOversight();
      renderThought();
    }),
    pillRow("tell me from", ["notice", "elevated", "critical"], S.alertFloor, (v) => {
      S.alertFloor = v as SignalCriticality;
      renderOversight();
    }),
    watchedLine,
  );
  if (!s) {
    tiles.replaceChildren(el("div", "empty-note", "No signals yet."));
    alerts.replaceChildren();
    lineages.replaceChildren();
    return;
  }
  tiles.replaceChildren(
    ...signalTiles(s).map(([l, v, c, hot]) => {
      const t = el("div", `tile${hot ? " hot" : ""}`);
      t.append(el("span", "lbl", l), el("span", "big", v), el("span", "cap", c));
      return t;
    }),
  );
  const shown = alertsAtOrAbove(s.alerts, S.alertFloor);
  const hidden = s.alerts.length - shown.length;
  const head = el("div", "lbl", `alerts · ${shown.length} at or above ${S.alertFloor}${hidden ? ` · ${hidden} below the floor` : ""}`);
  alerts.replaceChildren(
    head,
    ...(s.alerts.length === 0 ? [el("div", "empty-note", "nothing crossed a threshold in the last day")] : []),
    ...s.alerts.map((a) => {
      const row = el("div", `alert ${a.criticality}${shown.includes(a) ? "" : " below"}`);
      row.append(el("span", "crit", a.criticality), el("span", "txt", a.text), el("span", "since mono", `since t${a.firstTick}`));
      return row;
    }),
  );
  const rows = lineageRows(s, S.state?.agents ?? []);
  const notices = noticeRows(s, S.state?.tick ?? s.tick);
  lineages.replaceChildren(
    el("div", "lbl", `on notice · ${notices.length}`),
    ...(notices.length === 0 ? [el("div", "empty-note", "no node has been given notice")] : []),
    ...notices.map((n) => {
      const row = el("div", `lineage notice${n.held ? " held" : ""}`);
      const txt = el("span", "txt");
      txt.append(el("b", "", n.name), el("span", "", ` · ${n.when} · ${n.told}`), el("br"), el("span", "", n.did), el("br"), el("span", "dim", n.pace));
      row.append(el("span", "hash mono", n.held ? "held" : "notice"), txt, el("span", "since", ""));
      return row;
    }),
    el("div", "lbl", `lineages · ${rows.length}`),
    ...(rows.length === 0 ? [el("div", "empty-note", "no two living nodes run the same main.js")] : []),
    ...rows.map((r) => {
      const row = el("div", "lineage");
      row.append(el("span", "hash mono", r.hash), el("span", "txt", `${r.names.length} nodes: ${r.names.join(", ")}`), el("span", "since", r.ruin ? `same as ${r.ruin}'s` : ""));
      return row;
    }),
  );
}
// ---------- timeline ----------
const SVG = "http://www.w3.org/2000/svg";
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}
/** The record from the server when it keeps one, else what this client has seen. Then draw. */
async function loadTimeline(): Promise<void> {
  let view: TimelineView | null = null;
  try {
    const r = await fetch("/api/history/timeline");
    if (r.ok) view = (await r.json()) as TimelineView;
  } catch {
    // no server history: fall through to the live ring
  }
  S.timeline = view ?? timelineFromEvents(S.events);
  renderTimeline();
}
async function loadAround(tick: number): Promise<void> {
  const span = 20;
  let events: WorldEvent[] | null = null;
  if (S.timeline?.source === "history") {
    try {
      const r = await fetch(`/api/history/events?from=${tick - span}&to=${tick + span}&limit=80`);
      if (r.ok) events = (await r.json()) as WorldEvent[];
    } catch {
      // fall through
    }
  }
  S.timelineAround = { tick, events: events ?? S.events.filter((e) => Math.abs(e.tick - tick) <= span) };
  renderTimeline();
}
function renderTimeline(): void {
  const v = S.timeline;
  const head = $("tlHead");
  const axis = $("tlAxis") as unknown as SVGSVGElement;
  const firsts = $("tlFirsts");
  const around = $("tlAround");
  if (!v) {
    head.replaceChildren(el("div", "empty-note", "loading the record…"));
    return;
  }
  const tpd = S.config?.ticksPerDay ?? 240;
  // Draw in real pixels so labels keep their size: the longest label is about 150px at 11px type.
  const W = Math.max(240, Math.round(axis.clientWidth || 1000));
  const H = 140;
  axis.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const lay = layoutTimeline(v, tpd, Math.min(0.9, 156 / W), 5);
  head.replaceChildren(
    el("span", "lbl", v.source === "history" ? `from the record on disk · t${v.firstTick} to t${v.lastTick}` : `from what this client has seen · t${v.firstTick} to t${v.lastTick}`),
    el("span", "lbl", `${v.days.reduce((s, d) => s + d.total, 0)} events over ${v.days.length} day${v.days.length === 1 ? "" : "s"}`),
  );
  const base = H - 24;
  const barH = 40;
  axis.replaceChildren();
  axis.appendChild(svgEl("line", { x1: 0, y1: base, x2: W, y2: base, class: "base" }));
  for (const b of lay.bars) {
    const r = svgEl("rect", { x: b.x * W, y: base - b.h * barH, width: Math.max(1, b.w * W - 1), height: Math.max(1, b.h * barH), class: "bar" });
    r.appendChild(svgEl("title", {}, `day ${b.day}: ${b.total} events`));
    axis.appendChild(r);
    axis.appendChild(svgEl("text", { x: b.x * W + 3, y: H - 8, class: "day" }, `d${b.day}`));
  }
  for (const m of lay.markers) {
    const x = m.x * W;
    const y = base - barH - 8 - m.row * 15;
    axis.appendChild(svgEl("line", { x1: x, y1: y + 3, x2: x, y2: base, class: "tick" }));
    const t = svgEl("text", { x: x + 4, y, class: "mk" }, m.label);
    t.addEventListener("click", () => void loadAround(m.tick));
    axis.appendChild(t);
  }
  firsts.replaceChildren(
    el("div", "lbl", `firsts · ${v.firsts.length}`),
    ...(v.firsts.length === 0 ? [el("div", "empty-note", "nothing has happened yet")] : []),
    ...v.firsts.map((f) => {
      const row = el("div", "tl-first");
      const left = el("div", "");
      left.append(el("div", "tag", f.label), eventRow(f.event));
      const b = el("button", "tbtn", `around t${f.event.tick}`) as HTMLButtonElement;
      b.type = "button";
      b.addEventListener("click", () => void loadAround(f.event.tick));
      row.append(left, b);
      return row;
    }),
  );
  const a = S.timelineAround;
  around.replaceChildren(
    el("div", "lbl", a ? `around t${a.tick} · ${a.events.length} events` : "around a moment"),
    ...(a ? (a.events.length ? a.events.map((e) => eventRow(e)) : [el("div", "empty-note", "nothing recorded near that tick")]) : [el("div", "empty-note", "pick a first to see what was happening around it, in the record's own words")]),
  );
}
function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

// ---------- controls ----------
$("btnPause").addEventListener("click", () => send({ type: S.pacing?.paused ? "resume" : "pause" }));
for (const b of $("speedSeg").querySelectorAll<HTMLButtonElement>("button")) {
  b.addEventListener("click", () => {
    const sp = Number(b.dataset.speed) as Speed;
    if ((SPEEDS as readonly number[]).includes(sp)) send({ type: "speed", speed: sp });
  });
}
$("btnSpawn").addEventListener("click", () => {
  send({ type: "spawn" });
  toast("spawning a node…");
});
// Operator token: asked for once per browser session, kept in sessionStorage, forgotten when the server refuses it.
const tokenDialog = $("tokenDialog") as HTMLDialogElement;
const tokenValue = $("tokenValue") as HTMLInputElement;
function openTokenDialog(): void {
  if (tokenDialog.open) return;
  tokenValue.value = "";
  tokenDialog.showModal();
  tokenValue.focus();
}
$("tokenCancel").addEventListener("click", () => tokenDialog.close());
$("tokenForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const t = tokenValue.value.trim();
  tokenDialog.close();
  if (!t) return;
  storeOperatorToken(t);
  renderBadge();
  toast("operator token kept for this session");
});
$("operatorBadge").addEventListener("click", () => {
  if (S.operatorToken) {
    storeOperatorToken("");
    renderBadge();
    toast("operator token forgotten");
  } else openTokenDialog();
});
loadOperatorToken();

// Reset: opens a dialog, and the reset button stays disabled until the word is typed.
const resetDialog = $("resetDialog") as HTMLDialogElement;
const resetPhrase = $("resetPhrase") as HTMLInputElement;
const resetGo = $("resetGo") as HTMLButtonElement;
$("btnReset").addEventListener("click", () => {
  const st = S.state;
  const living = st?.agents.filter((a) => a.alive).length ?? 0;
  const ruins = (st?.ruins.length ?? 0) + (st?.agents.filter((a) => !a.alive).length ?? 0);
  $("resetFacts").textContent = st ? `Day ${st.day}: ${living} living node${living === 1 ? "" : "s"}, ${ruins} ruin${ruins === 1 ? "" : "s"}.` : "";
  resetPhrase.value = "";
  resetGo.disabled = true;
  resetDialog.showModal();
  resetPhrase.focus();
});
resetPhrase.addEventListener("input", () => {
  resetGo.disabled = resetPhrase.value !== "RESET";
});
$("resetCancel").addEventListener("click", () => resetDialog.close());
$("resetForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (resetPhrase.value !== "RESET") return;
  resetDialog.close();
  void fetch("/api/reset", { method: "POST", headers: { "content-type": "application/json", ...operatorHeaders() }, body: JSON.stringify({ confirm: "RESET" }) }).then(async (r) => {
    if (r.status === 401) {
      storeOperatorToken("");
      renderBadge();
      openTokenDialog();
    }
    if (!r.ok) toast(`reset refused: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status}`);
  });
});
// Rewind a node's files: a dialog, and the button stays disabled until the word is typed.
const rewindDialog = $("rewindDialog") as HTMLDialogElement;
const rewindPhrase = $("rewindPhrase") as HTMLInputElement;
const rewindGo = $("rewindGo") as HTMLButtonElement;
let rewindTarget: string | null = null;
function openRewind(a: AgentView): void {
  rewindTarget = a.id;
  $("rewindFacts").textContent = `${a.name}: ${a.fileCount} file${a.fileCount === 1 ? "" : "s"}, ${fmtBytes(a.fsBytes)}, ${a.turns} turn${a.turns === 1 ? "" : "s"} so far.`;
  rewindPhrase.value = "";
  rewindGo.disabled = true;
  rewindDialog.showModal();
  rewindPhrase.focus();
}
rewindPhrase.addEventListener("input", () => {
  rewindGo.disabled = rewindPhrase.value !== "REWIND";
});
$("rewindCancel").addEventListener("click", () => rewindDialog.close());
$("rewindForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (rewindPhrase.value !== "REWIND" || !rewindTarget) return;
  rewindDialog.close();
  send({ type: "rewind", agentId: rewindTarget, confirm: "REWIND" });
});
window.addEventListener("resize", () => {
  if (S.nerdTab === "timeline" && document.body.classList.contains("nerd-open") && S.timeline) renderTimeline();
});
$("btnNerd").addEventListener("click", () => openNerd(!document.body.classList.contains("nerd-open")));
$("nerdClose").addEventListener("click", () => openNerd(false));
for (const b of $("nerdTabs").querySelectorAll<HTMLButtonElement>("button")) b.addEventListener("click", () => setNerdTab(b.dataset.tab as typeof S.nerdTab));
$("btnNarrate").addEventListener("click", () => {
  S.narrate = !S.narrate;
  $("btnNarrate").setAttribute("aria-pressed", String(S.narrate));
  if (!S.narrate) window.speechSynthesis?.cancel();
  else if (!window.speechSynthesis) toast("speech synthesis is not available in this browser");
});
$("chkAll").addEventListener("change", (e) => {
  S.showAll = (e.target as HTMLInputElement).checked;
  rebuildChronicle();
});
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === " ") {
    e.preventDefault();
    send({ type: S.pacing?.paused ? "resume" : "pause" });
  } else if (e.key === "Escape") {
    if (document.body.classList.contains("nerd-open")) openNerd(false);
    else if (S.selectedTile !== null) selectTile(null);
    else selectAgent(null);
  } else if (e.key === "f") world.fit();
  else if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send({ type: "snapshot" });
    toast("snapshot requested");
  }
});

// ---------- mobile tabs ----------
function setMobileTab(tab: typeof S.mobileTab, syncNerd = true): void {
  S.mobileTab = tab;
  document.body.classList.remove("tab-world", "tab-groups", "tab-chronicle", "tab-hood");
  document.body.classList.add(`tab-${tab}`);
  for (const b of $("tabbar").querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("active", b.dataset.tab === tab);
  if (syncNerd) {
    const open = tab === "hood";
    document.body.classList.toggle("nerd-open", open);
    $("btnNerd").setAttribute("aria-pressed", String(open));
    if (open) renderNerd();
  }
  refreshGuards();
}
/** Close every overlay: dossier, drawer, mobile tabs back to the world. */
function closeAll(): void {
  if (document.body.classList.contains("nerd-open")) openNerd(false);
  if (isMobile()) setMobileTab("world");
  S.selectedTile = null;
  world.setSelectedTile(null);
  selectAgent(null);
  renderDossier();
}
for (const b of $("tabbar").querySelectorAll<HTMLButtonElement>("button")) b.addEventListener("click", () => setMobileTab(b.dataset.tab as typeof S.mobileTab));
window.matchMedia(MOBILE_MQ).addEventListener("change", (e) => {
  if (!e.matches) setMobileTab("world", false);
});

// ---------- toast ----------
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

// ---------- stable dev API for automated checks (window.__llmwar) ----------
declare global {
  interface Window {
    __llmwar?: {
      world: World;
      /** Latest WorldState (live getter). */
      readonly state: WorldState | null;
      /** Current TileView[] (live getter; updated on `tiles` messages). */
      readonly tiles: TileView[];
      selectAgent: (id: string | null) => void;
      selectTile: (q: number, r: number) => void;
      goToTile: (q: number, r: number) => void;
      openTab: (t: "world" | "groups" | "chronicle" | "hood") => void;
      openHoodTab: (t: "brain" | "nodes" | "pacing" | "oversight" | "timeline") => void;
      coverage: () => number;
      closeAll: () => void;
      setMobileTab: (t: "world" | "groups" | "chronicle" | "hood") => void;
      agentScreenPos: (id: string) => { x: number; y: number } | null;
      tileScreenPos: (q: number, r: number) => { x: number; y: number } | null;
    };
  }
}

// ---------- boot ----------
async function boot(): Promise<void> {
  await world.init();
  for (const id of ["railLeft", "railRight", "dossier", "nerd"]) guardOverflow($(id));
  const mock = new URLSearchParams(location.search).get("mock");
  if (mock) {
    const { createMockTransport } = await import("./dev-mock");
    transport = createMockTransport();
  } else {
    transport = createWebSocketTransport();
  }
  transport.onStatus((c) => {
    S.connected = c;
    renderBadge();
    if (!c) toast("connection lost — retrying…");
  });
  transport.onMessage(onMessage);
  renderBadge();
  const screenPos = (q: number, r: number) => {
    const p = hexToPixel(q, r, HEX_SIZE);
    return { x: (p.x - world.cam.cx) * world.cam.zoom + world.viewportW / 2, y: (p.y - world.cam.cy) * world.cam.zoom + world.viewportH / 2 };
  };
  window.__llmwar = {
    world,
    get state() {
      return S.state;
    },
    get tiles() {
      return S.tiles;
    },
    selectAgent,
    selectTile: (q, r) => selectTile(tileKey(q, r)),
    goToTile: (q, r) => goToTile(tileKey(q, r)),
    openTab: (t) => {
      if (isMobile()) setMobileTab(t);
      else if (t === "hood") openNerd(true);
      else openNerd(false);
    },
    openHoodTab: (t) => {
      if (!document.body.classList.contains("nerd-open")) openNerd(true);
      setNerdTab(t);
    },
    coverage: () => world.coverage(),
    closeAll,
    setMobileTab,
    tileScreenPos: (q, r) => {
      const t = world.tileAt(tileKey(q, r));
      return t ? screenPos(t.q, t.r) : null;
    },
    agentScreenPos: (id) => {
      const a = S.state?.agents.find((x) => x.id === id);
      return a ? screenPos(a.q, a.r) : null;
    },
  };
}
boot().catch((err) => {
  console.error(err);
  toast(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
});
