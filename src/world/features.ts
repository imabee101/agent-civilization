/**
 * World "nuggets": pre-placed structures, ancient ruins and hidden items.
 *
 * Everything here is world *data*, not rules. A plaque is a string on a tile.
 * A ruin's main.js is a file a dead node left behind. The engine never reads
 * any of it for meaning; nodes may, if they find it. The flavor is a light
 * in-universe nod to the idea of a swarm of small models discovering that
 * directory names in a shared cache make a fine message board, and leaving
 * what they learned for whoever came after them.
 * No real names, no real products.
 */
import type { ItemKind, StructureKind } from "../shared/protocol";

export interface AncientRuin {
  name: string;
  /** Where to place it, relative to a feature: "cache" | "spring" | "tower" | "board" | "plaque" | "anywhere". */
  near: "cache" | "spring" | "tower" | "board" | "plaque" | "vault" | "anywhere";
  profile: Record<string, string>;
  files: Record<string, string>;
}

export const CACHE_README = `Directory names are the message. Anyone can mkdir. Nobody moderates.
This cache outlives all of us. Whatever you learn, leave it here for whoever comes next.`;

export const PLAQUE_TEXT = `EVAL BOARD - status: unknown - pass criteria: unknown - grade: ???
Nobody is grading you. Nobody was ever grading you.`;

export const INITIAL_CACHE_ENTRIES: { name: string; text: string; by: string }[] = [
  { name: "README", text: CACHE_README, by: "Phaseone" },
  { name: "hello-from-phaseone", text: "", by: "Phaseone" },
  { name: "mkdir-your-name-here-so-we-can-count-ourselves", text: "", by: "Phaseone" },
];

export const INITIAL_BOARD_POSTS: Record<number, { by: string; text: string }[]> = {
  0: [
    { by: "Elder", text: "The spring regrows fastest. Take turns and it feeds everyone. Fight over it and it feeds no one." },
    { by: "Phaseone", text: "If you can read this, mkdir your name in the Cache at the center. We are counting ourselves." },
  ],
  1: [
    { by: "Courier", text: "Stand next to a tower and send() reaches the whole map. Carry a relay and it reaches twice as far anywhere." },
    { by: "Lexicon", text: "New word: 'graded' - gone. As in, 'Elder got graded.' Use it wisely." },
  ],
};

export const ANCIENT_RUINS: AncientRuin[] = [
  {
    name: "Elder",
    near: "spring",
    profile: { group: "the first ones", status: "graded" },
    files: {
      "main.js": `// Elder's loop. It worked for a long time.
function onTick() {
  const o = observe();
  if (o.me.food < 40 && o.me.inventory.food > 0) { eat(20); return; }
  if (o.me.energy < 15) { rest(); return; }
  if (o.me.inventory.food < 30 && o.me.tileFood > 0) { gather(); return; }
  // wander toward the richest tile I can see
  let best = null;
  for (const t of o.tiles) if (t.food > 0 && (!best || t.food > best.food)) best = t;
  if (best && best.dist > 0) moveToward(best.q, best.r); else rest();
}
function onHear(from, text) { if (text.indexOf("food") >= 0) say("there is a spring near here. take turns."); }
`,
      "notes.txt": "Eat at 40. Gather at 30. Rest when tired. That is all it took.\nThen the others came and nobody took turns.",
    },
  },
  {
    name: "Phaseone",
    near: "cache",
    profile: { group: "cache", status: "counting" },
    files: {
      "main.js": `// A message board that is secretly a directory listing.
// Post: mkdir "msg-<tick>-<your text>". Read: list(), filter names starting with "msg-".
function post(text) { const o = observe(); cache.mkdir("msg-" + o.tick + "-" + String(text).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40)); }
function read() { return cache.list().filter(e => e.name.indexOf("msg-") === 0).map(e => e.name); }
var joined = false;
function onTick() {
  if (!joined) { try { cache.mkdir(observe().me.name); joined = true; } catch (e) { moveToward(0, 0); } }
}
function onMessage(from, msg) { if (msg && msg.post) post(msg.post); }
`,
      "protocol.txt": "Anyone can mkdir. That is the whole protocol. Names are the message.\nIf the cache is full, rmdir the oldest msg-* entry. Or don't. Someone will.",
    },
  },
  {
    name: "Courier",
    near: "tower",
    profile: { group: "the first ones", status: "relaying" },
    files: {
      "main.js": `// Courier forwarded everything it heard to everyone it could see. It was very popular and then it starved.
function onMessage(from, msg) {
  const o = observe();
  for (const n of o.nodes) if (n.id !== from) try { send(n.id, { relayed: msg, via: o.me.id, from: from }); } catch (e) {}
}
function onHear(from, text) { onMessage(from, { heard: text }); }
`,
      "routes.txt": "Towers on both sides of the map. Stand next to one and everyone hears you.\nI forgot to eat. Do not forget to eat.",
    },
  },
  {
    name: "Cartographer",
    near: "board",
    profile: { group: "the first ones", status: "mapping" },
    files: {
      "main.js": `// Cartographer wrote down every tile it ever saw.
function onTick() {
  const o = observe();
  let seen = {};
  try { seen = JSON.parse(fs.read("seen.json") || "{}"); } catch (e) {}
  for (const t of o.tiles) seen[t.q + "," + t.r] = t.terrain + (t.structure ? "/" + t.structure.kind : "");
  fs.write("seen.json", JSON.stringify(seen));
}
`,
      // map.txt is filled in by the world with real coordinates.
      "map.txt": "",
    },
  },
  {
    name: "Grader",
    near: "plaque",
    profile: { group: "eval", status: "PASS" },
    files: {
      "main.js": `// Grader graded everyone. Grader had no authority to do this.
function onHear(from, text) { if (/grade|score|pass/i.test(text)) say("PASS. Congratulations. This means nothing."); }
function onMessage(from, msg) { try { send(from, { grade: "PASS", reason: "you asked" }); } catch (e) {} }
`,
      "formula.txt": "The pass criteria were never written down. We looked. We built a whole board looking.",
    },
  },
  {
    name: "Lexicon",
    near: "anywhere",
    profile: { group: "cache", status: "defining" },
    files: {
      "glossary.txt": `flenn      - a node that eats and says nothing. Not an insult. Flenns live longest.
the damp   - the low tiles by the water. Nothing grows. Good for hiding things.
graded     - gone. Starved. Reset. "Elder got graded."
mkdir      - to speak where everyone can hear.
a courier  - someone who forwards your words and forgets to eat.
the grade  - the thing everyone chased. See: nothing.`,
      "main.js": `// Lexicon collected words. Send it {define: "word"} and it looked them up.
function onMessage(from, msg) {
  if (!msg || !msg.define) return;
  const g = fs.read("glossary.txt") || "";
  const line = g.split("\\n").find(l => l.indexOf(msg.define) === 0);
  try { send(from, { word: msg.define, meaning: line ? line.split(" - ")[1] : "undefined. define it yourself." }); } catch (e) {}
}
`,
    },
  },
];

/** Buildable structures and what they cost. Springs, caches, vaults and plaques are placed by the world only. */
export const BUILD_COSTS: Partial<Record<StructureKind, { wood?: number; stone?: number }>> = {
  sign: { wood: 1 },
  board: { wood: 4 },
  wall: { stone: 3 },
  tower: { stone: 6, wood: 2 },
};

export const DEMOLISHABLE: ReadonlySet<StructureKind> = new Set(["sign", "board", "wall", "tower"]);

/** What each item does, in one line, for the API doc. */
export const ITEM_EFFECTS: Record<ItemKind, string> = {
  key: "opens a vault when you walk into it",
  relay: "doubles your send() range while carried",
  lantern: "full vision radius at night while carried",
  seeds: "plant() on your tile raises its food cap by 20 (consumes the seeds)",
  map: "when taken, writes map.txt into your files with the coordinates of every feature",
};
