/**
 * The node API: the complete list of things a node's code can do.
 *
 * `PRELUDE` is JavaScript evaluated inside every node's sandbox before any
 * agent code. It turns the raw string-only host bridge (`__host`) into the
 * friendly globals below. `API_DOC` is the same API described for the model.
 */

export const API_DOC = `You control one node in a shared hex world. Your code runs in a sandboxed JavaScript interpreter (no modules, no timers, no network, no host filesystem). These globals exist:

PERCEPTION
  observe() -> { tick, day, phase, me:{id,name,q,r,food,energy,health,inventory:{food},profile,tileFood,terrain}, visionRadius, tiles:[{q,r,terrain,food,dist}], nodes:[{id,name,q,r,dist,profile,lastSaid}], ruins:[{id,name,q,r,dist,fileCount}], heard:[{tick,from,fromName,text}], inbox:[{tick,from,fromName,payload}] }

BODY (one of move/gather/drop/rest per tick; eat is extra)
  move(dir)            dir is 0..5 or "e","ne","nw","w","sw","se". Costs energy. Water and the map edge block.
  moveToward(q, r)     one step toward a hex, routing around water. Returns false if no step helps.
  gather()             take food from the tile you stand on into your inventory (costs energy).
  eat(n)               eat n food from your inventory. food 0 => health drains => death.
  drop(n)              leave n food on your tile (anyone here can gather it).
  rest()               regain energy.

COMMUNICATION
  say(text)            audible to nodes within a few hexes; they get onHear(fromId, text).
  send(toId, msg)      deliver any JSON value to a node in range; it gets onMessage(fromId, msg). Max 2 KB.

FILES (your private storage; survives your death as a readable ruin)
  fs.read(path) -> string|null   fs.write(path, text)   fs.list() -> [{path,bytes}]   fs.remove(path)
  ruins.files(ruinId)  ruins.read(ruinId, path)    only for a dead node on an adjacent hex.

SELF
  me.set(key, value)   public key/value about yourself, visible to others in observe(). e.g. me.set("group","river") or me.set("status","trading food"). Means whatever you decide it means.
  log(...args)         write to your private log (shown to you next turn).

PERSISTENT BEHAVIOUR
  Anything you define as a global function persists between your turns while you are alive. Save code in fs.write("main.js", src): main.js is re-run when it changes and after a restart, so put your handlers there:
    function onTick() {}                 // called every world tick (~ several per second)
    function onMessage(fromId, msg) {}   // called when a node sends you something
    function onHear(fromId, text) {}     // called when a nearby node says something
  Every call has a short time and memory budget; slow or huge code is interrupted.

There are no other rules. Nothing decides for you what a message means, who to trust, or whether to share. If you obey messages blindly, other nodes may exploit that. If you never gather or eat, you die.`;

export const PRELUDE = `
(function () {
  const h = globalThis.__host;
  delete globalThis.__host;
  const parse = (s) => (s === undefined || s === null ? null : JSON.parse(s));
  const ser = (v) => JSON.stringify(v === undefined ? null : v);
  globalThis.observe = () => parse(h.observe());
  globalThis.move = (dir) => h.move(dir);
  globalThis.moveToward = (q, r) => h.moveToward(q, r);
  globalThis.gather = () => h.gather();
  globalThis.eat = (n) => h.eat(n === undefined ? 10 : n);
  globalThis.drop = (n) => h.drop(n);
  globalThis.rest = () => h.rest();
  globalThis.say = (text) => h.say(typeof text === "string" ? text : ser(text));
  globalThis.send = (to, msg) => h.send(String(to), ser(msg));
  globalThis.fs = Object.freeze({
    read: (p) => h.fsRead(p),
    write: (p, c) => h.fsWrite(p, typeof c === "string" ? c : ser(c)),
    list: () => parse(h.fsList()),
    remove: (p) => h.fsRemove(p),
  });
  globalThis.ruins = Object.freeze({
    files: (id) => parse(h.ruinFiles(id)),
    read: (id, p) => h.ruinRead(id, p),
  });
  globalThis.me = Object.freeze({
    set: (k, v) => h.setProfile(k, v === undefined || v === null ? null : String(v)),
  });
  const fmt = (a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  globalThis.log = (...args) => h.log(args.map(fmt).join(" "));
  globalThis.console = Object.freeze({ log: globalThis.log, error: globalThis.log, warn: globalThis.log, info: globalThis.log });
})();
`;

/** Names of host bridge functions the sandbox expects, all string-in/string-out or primitive. */
export const HOST_FUNCTIONS = [
  "observe",
  "move",
  "moveToward",
  "gather",
  "eat",
  "drop",
  "rest",
  "say",
  "send",
  "fsRead",
  "fsWrite",
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
  move(dir: unknown): boolean;
  moveToward(q: unknown, r: unknown): boolean;
  gather(): void;
  eat(n: unknown): void;
  drop(n: unknown): void;
  rest(): void;
  say(text: unknown): void;
  send(to: unknown, payloadJson: string): void;
  fsRead(path: unknown): string | null;
  fsWrite(path: unknown, content: unknown): void;
  fsList(): unknown;
  fsRemove(path: unknown): boolean;
  ruinFiles(id: unknown): unknown;
  ruinRead(id: unknown, path: unknown): string | null;
  setProfile(key: unknown, value: unknown): void;
  log(line: string): void;
}

export const HANDLER_NAMES = ["onTick", "onMessage", "onHear"] as const;
export type HandlerName = (typeof HANDLER_NAMES)[number];
