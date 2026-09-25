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
import { categoryOf, colorOf, iconOf, formatEventMeta, isRibbonWorthy, hasQuote, ribbonKicker } from "./lib/events";
import { utteranceFor } from "./lib/narration";
import { sunElevation } from "./lib/phase";
import { hexToPixel } from "./lib/camera";
import { HEX_SIZE } from "./world";
import { ITEM_GLYPH, formatCacheEntry, indexTiles, listFeatures, mergeTiles, structureCss, tileDossier, tileKey } from "./lib/structures";
import { guardOverflow, refreshGuards } from "./overflow-guard";

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
  nodeDetails: new Map<string, NodeDetail>(),
  thoughts: new Map<string, { text: string; done: boolean }>(),
  brain: null as BrainStatus | null,
  pacing: null as PacingStats | null,
  connected: false,
  selectedId: null as string | null,
  selectedTile: null as string | null,
  watchedId: null as string | null,
  nerdTab: "brain" as "brain" | "nodes" | "pacing",
  nerdDecisionId: null as number | null,
  nerdNodeId: null as string | null,
  showAll: false,
  narrate: false,
  mobileTab: "world" as "world" | "groups" | "chronicle" | "hood",
  groupsKey: "",
};
const MAX_EVENTS = 300;
const MAX_ROWS = 200;
const MAX_DECISIONS = 120;

// ---------- transport ----------
let transport: Transport;
function send(msg: ClientMessage): void {
  transport.send(msg);
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
    case "tick":
      S.state = m.state;
      world.update(m.state);
      world.setTileFood(m.tileFood);
      minimap.agents = m.state.agents;
      minimap.ruins = m.state.ruins;
      minimap.draw();
      renderClock();
      renderStats();
      renderGroups();
      renderDossierLive();
      if (S.nerdTab === "nodes" && document.body.classList.contains("nerd-open")) renderNodeList();
      break;
    case "tiles":
      applyTiles(m.tiles);
      break;
    case "events":
      for (const e of m.events) addEvent(e);
      break;
    case "decision":
      S.decisions.push(m.decision);
      if (S.decisions.length > MAX_DECISIONS) S.decisions.splice(0, S.decisions.length - MAX_DECISIONS);
      if (document.body.classList.contains("nerd-open") && S.nerdTab === "brain") renderBrain();
      break;
    case "thinking":
      S.thoughts.set(m.agentId, { text: m.text, done: m.done });
      if (m.agentId === S.selectedId) renderThought();
      break;
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
  S.brain = h.brain;
  S.pacing = h.pacing;
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
  $("dayNum").textContent = `Day ${st.day}`;
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
  const alive = st.agents.filter((a) => a.alive);
  $("stAlive").textContent = S.config ? `${alive.length}/${S.config.maxPopulation}` : String(alive.length);
  const groups = deriveGroups(st.agents, st.ruins).filter((g) => !g.unaffiliated && !g.collapsed);
  $("stGroups").textContent = String(groups.length);
  $("stThinking").textContent = String(alive.filter((a) => a.thinking).length);
  $("stLatency").textContent = S.pacing ? fmtMs(S.pacing.avgLatencyMs) : "–";
}

function renderBadge(): void {
  const b = S.brain;
  const dot = $("brainDot");
  const on = !!b?.connected && S.connected;
  dot.classList.toggle("on", on);
  $("brainName").textContent = b ? `${b.kind} · ${b.model}` : S.connected ? "no brain" : "offline";
  $("brainBadge").title = b?.lastError ? `last error: ${b.lastError}` : b?.detail ?? "brain backend";
  $("pacingMode").textContent = S.pacing?.mode ?? "idle";
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
  const cards = deriveGroups(st.agents, st.ruins);
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
  const rows = S.events.filter((e) => S.showAll || e.importance >= 1).slice(-MAX_ROWS).reverse().map(eventRow);
  for (const r of rows) r.style.animation = "none";
  evList.replaceChildren(...rows);
}
function addEvent(e: WorldEvent): void {
  S.events.push(e);
  if (S.events.length > MAX_EVENTS) S.events.splice(0, S.events.length - MAX_EVENTS);
  if (S.showAll || e.importance >= 1) {
    evList.prepend(eventRow(e));
    while (evList.children.length > MAX_ROWS) evList.lastElementChild?.remove();
  }
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
  for (const k of d.items) {
    const c = el("span", "chip item");
    c.append(el("span", "g", ITEM_GLYPH[k] ?? "•"), el("span", "v", k));
    chips.appendChild(c);
  }
  $("dKV").replaceChildren(
    ...d.rows.map(([k, v]) => {
      const r = el("div", "kv");
      r.append(el("span", "k", k), el("span", "v", v));
      r.title = v;
      return r;
    }),
  );
  const textSec = $("dTileText");
  textSec.hidden = d.text === null;
  if (d.text !== null) {
    textSec.querySelector(".lbl")!.textContent = `${d.title} text`;
    const pre = textSec.querySelector("pre")!;
    pre.textContent = d.text.length ? d.text : "(blank)";
    pre.classList.toggle("blank", d.text.length === 0);
  }
  const postsSec = $("dTilePosts");
  postsSec.hidden = t.structure?.kind !== "board";
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
  const streaming = !!t && !t.done && !!a?.thinking;
  box.classList.toggle("streaming", streaming);
  const span = box.querySelector(".ttext")!;
  span.textContent = t?.text ? t.text : a?.thinking ? "…" : "quiet";
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
  } else renderPacing();
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
    preBlock("system prompt", d.prompt.system, "plain"),
    preBlock("user prompt", d.prompt.user, "plain"),
    preBlock("raw output", d.output, ok ? "ok" : "err"),
    ...(d.code ? [preBlock("executed code", d.code, ok ? "ok" : "err")] : []),
    ...(d.result ? [preBlock("result", d.result, "ok")] : []),
    ...(d.error ? [preBlock("error", d.error, "err")] : []),
  );
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
    ["tokens / s", p.avgTokensPerSec.toFixed(1), "average generation speed"],
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
$("btnReset").addEventListener("click", () => {
  if (confirm("Reset the world? Every node, ruin and file is discarded.")) send({ type: "reset" });
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
      openHoodTab: (t: "brain" | "nodes" | "pacing") => void;
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
