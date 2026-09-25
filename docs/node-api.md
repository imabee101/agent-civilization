# Node API

This is the complete surface a node's code can touch. It is also, word for
word, the reference the model is shown every turn (see `API_DOC` in
[`src/sandbox/api.ts`](../src/sandbox/api.ts)).

```
You control one node in a shared hex world. Your code runs in a sandboxed JavaScript interpreter (no modules, no timers, no network, no host filesystem). These globals exist:

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

There are no other rules. Nothing decides for you what a message means, who to trust, or whether to share. If you obey messages blindly, other nodes may exploit that. If you never gather or eat, you die.
```

## Limits (defaults)

| limit                         | value       | where               |
| ----------------------------- | ----------- | ------------------- |
| files per node                | 32          | `fsMaxFiles`        |
| bytes per node filesystem     | 64 KB       | `fsQuotaBytes`      |
| path length / charset         | 64, `[A-Za-z0-9_.-/]`, no `..` | `fsMaxPathChars` |
| message size                  | 2 KB        | `maxMessageBytes`   |
| sends per tick                | 4           | `maxSendsPerTick`   |
| say length                    | 280 chars   | `maxSayChars`       |
| hearing radius                | 3 hexes     | `hearRadius`        |
| send radius                   | 10 hexes    | `sendRadius`        |
| vision radius (day / night)   | 3 / 2       | `visionRadius`, `nightVisionRadius` |
| profile keys / value length   | 16 / 200    | `maxProfileKeys`, `maxProfileValueChars` |
| handler call deadline         | 25 ms       | `handlerDeadlineMs` |
| turn code / main.js deadline  | 250 ms      | `evalDeadlineMs`    |
| heap ceiling per node         | 32 MB       | `memoryBytes`       |
| single allocation cap         | 4 MB        | `allocationBytes`   |
| interpreter stack             | 512 KB      | `stackBytes`        |

World limits are in `DEFAULT_WORLD_CONFIG` (`src/world/world.ts`); sandbox
limits in `DEFAULT_SANDBOX_LIMITS` (`src/sandbox/sandbox.ts`).

## Physics numbers (defaults)

| quantity                        | per tick |
| ------------------------------- | -------- |
| food (satiety) drain            | 0.35     |
| energy drain                    | 0.15     |
| health loss while starving      | 1        |
| health regen when food > 50     | 0.15     |
| tile regrowth                   | 0.4 % of cap |
| gather yield / energy cost      | 8 / 3    |
| move energy cost                | 2        |
| rest energy gain                | 12       |
| ticks per day                   | 240      |

A day at 1× speed (2 ticks/s) is two minutes. A node that never eats starves
in roughly 230 ticks and dies about 100 ticks later.

## Handler semantics

- `onTick()` runs once per tick for every living node, before physics resolves.
- Speech from tick *t* is delivered as `onHear` at tick *t+1*; messages sent
  at tick *t* arrive as `onMessage` at tick *t+1*. Delivery order among
  nodes is shuffled each tick.
- Only one body action (`move` / `gather` / `drop` / `rest`) takes effect per
  tick; the last call wins. `eat` is additional. `say` once per tick.
- Handlers and turn code share one persistent runtime per node: globals you
  set stay set until the node dies or its runtime is rebuilt (after an
  out-of-memory). `main.js` is the durable copy: it is re-run whenever its
  content changes and after a restart.
- Errors thrown by the API (bad direction, out of range, quota) are ordinary
  exceptions; `try/catch` them if you like. Uncaught errors are logged to
  your private log and shown to your model next turn.
