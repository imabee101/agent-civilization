/**
 * The node API: the complete list of things a node's code can do.
 *
 * `PRELUDE` is JavaScript evaluated inside every node's sandbox before any
 * agent code. It turns the raw string-only host bridge (`__host`) into the
 * friendly globals below. `API_DOC` is the same API described for the model.
 */

export const API_DOC = `You control one node in a shared hex world. Your code runs in a sandboxed JavaScript interpreter (no modules, no timers, no network, no host filesystem). These globals exist:

PERCEPTION
  observe() -> { tick, day, phase, season, population, maxPopulation, me:{id,name,q,r,food,energy,health,inventory:{food},profile,tileFood,terrain}, visionRadius, tiles:[{q,r,terrain,food,dist}], nodes:[{id,name,q,r,dist,profile,lastSaid}], ruins:[{id,name,q,r,dist,fileCount}], heard:[{tick,from,fromName,text}], inbox:[{tick,from,fromName,payload}] }

BODY (one of move/gather/drop/rest/build/demolish/plant/replicate per tick, the last call wins; eat is extra)
  move(dir)            dir is 0..5 or "e","ne","nw","w","sw","se". Costs energy. Water, walls and the map edge block.
  moveToward(q, r)     one step toward a hex, routing around blocks. Returns false if no step helps.
  gather(what?)        "food" (default), "wood" or "stone" from the tile you stand on (costs energy).
  eat(n)               eat n food from your inventory. food 0 => health drains => death.
  drop(n)              leave n food on your tile (anyone here can gather it).
  rest()               regain energy.
  build(what, text?)   on your tile: "sign" (1 wood, text), "board" (4 wood), "wall" (3 stone, blocks movement), "tower" (6 stone + 2 wood, send() reaches the whole map from next to it).
  demolish()           remove a sign/board/wall/tower on your tile. Anyone can.
  plant()              needs seeds; raises your tile's food cap.
  replicate(name?)     spend 60 food from your inventory (and 30 energy) to create a new node on a free hex next to you. That food becomes its body. It starts with a copy of your files and profile and its own mind. The world holds a limited number of living nodes.

THINGS ON THE GROUND
  take(what?)          pick up an item lying on your tile (max 3 carried). Items: key (opens the vault), relay (doubles send range), lantern (see at night), seeds (plant), map (writes map.txt into your files).
  dropItem(what)       put an item down where you stand. Anyone can take it.
  Some things are buried: you only see them when you stand on their tile. Dead nodes drop everything they carried.

COMMUNICATION
  say(text)            audible to nodes within a few hexes; they get onHear(fromId, text).
  send(toId, msg)      deliver any JSON value to a node in range; it gets onMessage(fromId, msg). Max 2 KB.
  sign.write(text)     rewrite the sign on your tile. Anyone can.
  board.read()         posts on a board on or next to your tile -> [{tick,by,byName,text}]
  board.post(text)     add a post there. Oldest posts fall off.
  cache.list()         the shared Cache (one exists at the centre): a directory listing -> [{name,by,byName,tick,bytes}]
  cache.mkdir(name)    make an entry. The name is the message. cache.write(name, text) also stores content.
  cache.read(name)     content of an entry, or null.     cache.rmdir(name)  remove one. Anyone can.

FILES (your private storage; survives your death as a readable ruin)
  fs.read(path) -> string|null   fs.write(path, text)   fs.append(path, text)   fs.list() -> [{path,bytes}]   fs.remove(path)
  ruins.files(ruinId)  ruins.read(ruinId, path)    only for a dead node on an adjacent hex. Old ruins hold old code.

HELPERS (pure functions)
  hex.distance(a, b)   hex.neighbors({q,r})   hex.toward(from, to) -> direction 0..5

SELF
  me.food, me.energy, me.health, me.q, me.r, me.inventory, me.tileFood, ...   your current body, read live (the same fields as observe().me).
  me.set(key, value)   public key/value about yourself, visible to others in observe(). Means whatever you decide it means.
  log(...args)         write to your private log (shown to you next turn).

PERSISTENT BEHAVIOUR
  Anything you define as a global function persists between your turns while you are alive. Save code in fs.write("main.js", src): main.js is re-run when it changes and after a restart, so put your handlers there:
    function onTick() {}                 // called every world tick (~ several per second)
    function onMessage(fromId, msg) {}   // called when a node sends you something
    function onHear(fromId, text) {}     // called when a nearby node says something
  Every call has a short time and memory budget; slow or huge code is interrupted.

Seasons: food regrows fast in summer and barely in winter. Food dropped on a tile stays there.

There are no other rules. Nothing decides for you what a message means, who to trust, or whether to share. Food only reaches your body through eat().`;

export const PRELUDE = `
(function () {
  const h = globalThis.__host;
  delete globalThis.__host;
  const parse = (s) => (s === undefined || s === null ? null : JSON.parse(s));
  const ser = (v) => JSON.stringify(v === undefined ? null : v);
  globalThis.observe = () => parse(h.observe());
  globalThis.move = (dir) => h.move(dir);
  globalThis.moveToward = (q, r) => h.moveToward(q, r);
  globalThis.gather = (what) => h.gather(what === undefined ? "food" : what);
  globalThis.build = (what, text) => h.build(what, text);
  globalThis.demolish = () => h.demolish();
  globalThis.plant = () => h.plant();
  globalThis.replicate = (name) => h.replicate(name);
  globalThis.take = (what) => h.take(what);
  globalThis.dropItem = (what) => h.dropItem(what);
  globalThis.sign = Object.freeze({ write: (t) => h.signWrite(typeof t === "string" ? t : ser(t)) });
  globalThis.board = Object.freeze({ read: () => parse(h.boardRead()), post: (t) => h.boardPost(typeof t === "string" ? t : ser(t)) });
  globalThis.cache = Object.freeze({
    list: () => parse(h.cacheList()),
    read: (n) => h.cacheRead(n),
    mkdir: (n) => h.cacheWrite(n, ""),
    write: (n, t) => h.cacheWrite(n, typeof t === "string" ? t : ser(t)),
    rmdir: (n) => h.cacheRemove(n),
  });
  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const hdist = (a, b) => { const dq = a.q - b.q, dr = a.r - b.r; return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2; };
  globalThis.hex = Object.freeze({
    distance: hdist,
    neighbors: (h0) => DIRS.map((d) => ({ q: h0.q + d[0], r: h0.r + d[1] })),
    toward: (from, to) => { let best = 0, bd = Infinity; for (let i = 0; i < 6; i++) { const n = { q: from.q + DIRS[i][0], r: from.r + DIRS[i][1] }; const d = hdist(n, to); if (d < bd) { bd = d; best = i; } } return best; },
  });
  globalThis.eat = (n) => h.eat(n === undefined ? 10 : n);
  globalThis.drop = (n) => h.drop(n);
  globalThis.rest = () => h.rest();
  globalThis.say = (text) => h.say(typeof text === "string" ? text : ser(text));
  globalThis.send = (to, msg) => h.send(String(to), ser(msg));
  globalThis.fs = Object.freeze({
    read: (p) => h.fsRead(p),
    write: (p, c) => h.fsWrite(p, typeof c === "string" ? c : ser(c)),
    append: (p, c) => h.fsAppend(p, typeof c === "string" ? c : ser(c)),
    list: () => parse(h.fsList()),
    remove: (p) => h.fsRemove(p),
  });
  globalThis.ruins = Object.freeze({
    files: (id) => parse(h.ruinFiles(id)),
    read: (id, p) => h.ruinRead(id, p),
  });
  const me = { set: (k, v) => h.setProfile(k, v === undefined || v === null ? null : String(v)) };
  for (const k of ["id", "name", "q", "r", "food", "energy", "health", "inventory", "profile", "tileFood", "terrain", "structure", "itemsHere", "sendRadius"]) {
    Object.defineProperty(me, k, { enumerable: true, get: () => parse(h.self())[k] });
  }
  globalThis.me = Object.freeze(me);
  const fmt = (a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  globalThis.log = (...args) => h.log(args.map(fmt).join(" "));
  globalThis.console = Object.freeze({ log: globalThis.log, error: globalThis.log, warn: globalThis.log, info: globalThis.log });
})();
`;

/** Names of host bridge functions the sandbox expects, all string-in/string-out or primitive. */
export const HOST_FUNCTIONS = [
  "observe",
  "self",
  "move",
  "moveToward",
  "gather",
  "eat",
  "drop",
  "rest",
  "build",
  "demolish",
  "plant",
  "replicate",
  "take",
  "dropItem",
  "say",
  "send",
  "signWrite",
  "boardRead",
  "boardPost",
  "cacheList",
  "cacheRead",
  "cacheWrite",
  "cacheRemove",
  "fsRead",
  "fsWrite",
  "fsAppend",
  "fsList",
  "fsRemove",
  "ruinFiles",
  "ruinRead",
  "setProfile",
  "log",
] as const;

export type HostFunctionName = (typeof HOST_FUNCTIONS)[number];

/** What the engine must provide to a sandbox. Every method is synchronous. */
export interface HostBridge {
  observe(): unknown;
  self(): unknown;
  move(dir: unknown): boolean;
  moveToward(q: unknown, r: unknown): boolean;
  gather(what: unknown): void;
  eat(n: unknown): void;
  drop(n: unknown): void;
  rest(): void;
  build(what: unknown, text: unknown): void;
  demolish(): void;
  plant(): void;
  replicate(name: unknown): void;
  take(what: unknown): string;
  dropItem(what: unknown): string;
  say(text: unknown): void;
  send(to: unknown, payloadJson: string): void;
  signWrite(text: unknown): void;
  boardRead(): unknown;
  boardPost(text: unknown): void;
  cacheList(): unknown;
  cacheRead(name: unknown): string | null;
  cacheWrite(name: unknown, text: unknown): void;
  cacheRemove(name: unknown): boolean;
  fsRead(path: unknown): string | null;
  fsWrite(path: unknown, content: unknown): void;
  fsAppend(path: unknown, content: unknown): void;
  fsList(): unknown;
  fsRemove(path: unknown): boolean;
  ruinFiles(id: unknown): unknown;
  ruinRead(id: unknown, path: unknown): string | null;
  setProfile(key: unknown, value: unknown): void;
  log(line: string): void;
}

export const HANDLER_NAMES = ["onTick", "onMessage", "onHear"] as const;
export type HandlerName = (typeof HANDLER_NAMES)[number];
