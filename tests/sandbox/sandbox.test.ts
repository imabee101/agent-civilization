/**
 * Adversarial tests for the outer sandbox boundary. If any of these fail,
 * agent code can hurt the host, and that is the one thing this project must
 * never allow.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { NodeSandbox, type SandboxLimits } from "../../src/sandbox/sandbox";
import type { HostBridge } from "../../src/sandbox/api";
import { HOST_FUNCTIONS } from "../../src/sandbox/api";

function fakeBridge(overrides: Partial<HostBridge> = {}): HostBridge & { calls: [string, unknown[]][]; logs: string[] } {
  const calls: [string, unknown[]][] = [];
  const logs: string[] = [];
  const rec =
    <T>(name: string, ret: T) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return ret;
    };
  return {
    calls,
    logs,
    observe: rec("observe", { tick: 1, me: { id: "n0", q: 0, r: 0 }, nodes: [], tiles: [] }),
    self: rec("self", { id: "n0", q: 0, r: 0, food: 42 }),
    move: rec("move", true),
    moveToward: rec("moveToward", true),
    gather: rec("gather", undefined),
    build: rec("build", undefined),
    demolish: rec("demolish", undefined),
    plant: rec("plant", undefined),
    replicate: rec("replicate", undefined),
    take: rec("take", "key"),
    dropItem: rec("dropItem", "key"),
    signWrite: rec("signWrite", undefined),
    boardRead: rec("boardRead", [{ tick: 1, by: "n1", byName: "A", text: "hi" }]),
    boardPost: rec("boardPost", undefined),
    cacheList: rec("cacheList", [{ name: "README", by: "ruin", byName: "P", tick: 0, bytes: 3 }]),
    cacheRead: rec("cacheRead", "content"),
    cacheWrite: rec("cacheWrite", undefined),
    cacheRemove: rec("cacheRemove", true),
    fsAppend: rec("fsAppend", undefined),
    eat: rec("eat", undefined),
    drop: rec("drop", undefined),
    rest: rec("rest", undefined),
    say: rec("say", undefined),
    send: rec("send", undefined),
    fsRead: rec("fsRead", "file contents"),
    fsWrite: rec("fsWrite", undefined),
    fsList: rec("fsList", [{ path: "main.js", bytes: 3 }]),
    fsRemove: rec("fsRemove", true),
    ruinFiles: rec("ruinFiles", []),
    ruinRead: rec("ruinRead", null),
    setProfile: rec("setProfile", undefined),
    log: (line: string) => {
      logs.push(line);
    },
    ...overrides,
  };
}

const boxes: NodeSandbox[] = [];
async function mk(limits: Partial<SandboxLimits> = {}, bridge = fakeBridge()) {
  const sb = await NodeSandbox.create(bridge, limits);
  boxes.push(sb);
  return { sb, bridge };
}
afterEach(() => {
  for (const b of boxes.splice(0)) b.dispose();
});

describe("sandbox: nothing from the host is reachable", () => {
  test("no runtime globals leak into the VM", async () => {
    const { sb } = await mk();
    const names = [
      "require",
      "process",
      "Bun",
      "Deno",
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "setTimeout",
      "setInterval",
      "setImmediate",
      "queueMicrotask",
      "std",
      "os",
      "print",
      "importScripts",
      "Worker",
      "__host",
      "module",
      "exports",
      "global",
      "window",
      "document",
      "navigator",
      "crypto",
      "TextDecoder",
      "TextEncoder",
      "WebAssembly",
    ];
    for (const n of names) {
      const r = sb.eval(`typeof ${n}`);
      expect(r.ok && r.value).toBe("undefined");
    }
  });

  test("the global namespace is exactly the ECMAScript builtins plus the node API", async () => {
    const { sb } = await mk({ resultChars: 10000 });
    const r = sb.eval("Object.getOwnPropertyNames(globalThis).sort().join(' ')");
    expect(r.ok).toBe(true);
    const builtins = [
      "AggregateError", "Array", "ArrayBuffer", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date",
      "Error", "EvalError", "Float32Array", "Float64Array", "Function", "Infinity", "Int16Array", "Int32Array", "Int8Array",
      "InternalError", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy", "RangeError", "ReferenceError",
      "Reflect", "RegExp", "Set", "SharedArrayBuffer", "String", "Symbol", "SyntaxError", "TypeError", "URIError",
      "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray", "WeakMap", "WeakSet", "decodeURI", "decodeURIComponent",
      "encodeURI", "encodeURIComponent", "escape", "eval", "globalThis", "isFinite", "isNaN", "parseFloat", "parseInt",
      "undefined", "unescape",
    ];
    const api = ["observe", "move", "moveToward", "gather", "eat", "drop", "rest", "build", "demolish", "plant", "replicate", "take", "dropItem", "say", "send", "sign", "board", "cache", "fs", "ruins", "me", "log", "console", "hex"];
    expect((r as any).value).toBe([...builtins, ...api].sort().join(" "));
  });

  test("dynamic import and import.meta are unavailable", async () => {
    const { sb } = await mk();
    const r = sb.eval(`(async () => { try { await import("fs"); return "imported"; } catch (e) { return "blocked:" + e.name; } })(); 1`);
    expect(r.ok).toBe(true);
    // Whether it rejects or is a syntax error, nothing observable happens on the host.
    const r2 = sb.eval(`import.meta`);
    expect(r2.ok).toBe(false);
  });

  test("the host bridge object is gone after the prelude and the wrappers are the only way in", async () => {
    const { sb, bridge } = await mk();
    expect(sb.eval("typeof __host").ok && (sb.eval("typeof __host") as any).value).toBe("undefined");
    expect(sb.eval("Object.keys(globalThis).includes('__host')")).toMatchObject({ ok: true, value: "false" });
    // Can an agent recover the raw bridge via the closures? Only through the wrappers, which is fine.
    sb.eval("observe()");
    expect(bridge.calls.at(-1)?.[0]).toBe("observe");
  });

  test("me exposes the live body next to set()", async () => {
    const { sb } = await mk();
    expect(sb.eval("me.food < 50 && me.id === 'n0'")).toMatchObject({ ok: true, value: "true" });
    expect(sb.eval("me.food = 1; me.food")).toMatchObject({ ok: true, value: "42" });
  });

  test("prototype pollution inside the VM does not reach the host", async () => {
    const { sb } = await mk();
    sb.eval("Object.prototype.polluted = 42; Array.prototype.push = function(){ return 'nope'; }");
    expect(({} as any).polluted).toBeUndefined();
    expect([1].push(2)).toBe(2);
  });

  test("throwing weird values does not break the host", async () => {
    const { sb } = await mk();
    for (const code of ["throw 1", "throw null", "throw {a:1}", "throw new Proxy({}, { get(){ throw new Error('trap') } })", "throw Symbol('x')"]) {
      const r = sb.eval(code);
      expect(r.ok).toBe(false);
      expect(typeof (r as any).error).toBe("string");
    }
    expect(sb.eval("1+1")).toMatchObject({ ok: true, value: "2" });
  });
});

describe("sandbox: time limits", () => {
  test("infinite loop in turn code is interrupted near the eval deadline", async () => {
    const { sb } = await mk({ evalDeadlineMs: 100 });
    const t0 = performance.now();
    const r = sb.eval("for(;;){}");
    const took = performance.now() - t0;
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/interrupted/);
    expect(took).toBeLessThan(600);
    expect(sb.poisoned).toBe(false);
    expect(sb.eval("2*3")).toMatchObject({ ok: true, value: "6" });
  });

  test("infinite loop in a handler is interrupted near the handler deadline", async () => {
    const { sb } = await mk({ handlerDeadlineMs: 30 });
    sb.loadScript("function onTick(){ while(true){} }");
    const t0 = performance.now();
    const r = sb.callHandler("onTick")!;
    expect(r.ok).toBe(false);
    expect(performance.now() - t0).toBeLessThan(400);
    expect(sb.poisoned).toBe(false);
  });

  test("a loop of host calls is still interrupted", async () => {
    const { sb, bridge } = await mk({ evalDeadlineMs: 80 });
    const r = sb.eval("for(;;){ observe(); }");
    expect(r.ok).toBe(false);
    expect(bridge.calls.length).toBeGreaterThan(10);
  });

  test("catching the interrupt inside the VM does not defeat it", async () => {
    const { sb } = await mk({ evalDeadlineMs: 60 });
    const t0 = performance.now();
    const r = sb.eval("for(;;){ try { for(;;){} } catch(e) {} }");
    expect(r.ok).toBe(false);
    expect(performance.now() - t0).toBeLessThan(600);
  });

  test("deep recursion hits the stack limit and the sandbox survives", async () => {
    const { sb } = await mk();
    const r = sb.eval("function f(){ return f() + 1 } f()");
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/stack overflow/i);
    expect(sb.poisoned).toBe(false);
    expect(sb.eval("'alive'")).toMatchObject({ ok: true, value: "alive" });
  });
});

describe("sandbox: memory limits", () => {
  test("a single huge allocation is rejected", async () => {
    const { sb } = await mk({ allocationBytes: 2 * 1024 * 1024, memoryBytes: 64 * 1024 * 1024 });
    const r = sb.eval("let s='x'; for(let i=0;i<40;i++){ s+=s } s.length");
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/out of memory/i);
    expect(sb.poisoned).toBe(true);
    expect(sb.eval("1")).toMatchObject({ ok: false, fatal: true });
  });

  test("many small allocations trip the heap guard and poison the node", async () => {
    const { sb } = await mk({ memoryBytes: 8 * 1024 * 1024, evalDeadlineMs: 5000 });
    const t0 = performance.now();
    const r = sb.eval("globalThis.a=[]; for(let i=0;i<1e8;i++){ a.push(new Array(1000).fill(i)) }");
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/out of memory/i);
    expect((r as any).fatal).toBe(true);
    expect(sb.poisoned).toBe(true);
    // Overshoot between two interrupt checks is bounded: nowhere near the 5s deadline, and
    // far below what an unguarded loop reached (190 MB+ in the same time).
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(sb.heapGrowth()).toBeLessThan(8 * 1024 * 1024 * 16);
  });

  test("many small allocations inside a handler trip the guard too", async () => {
    const { sb } = await mk({ memoryBytes: 8 * 1024 * 1024, handlerDeadlineMs: 5000 });
    sb.loadScript("globalThis.keep=[]; function onTick(){ for(let i=0;i<1e8;i++){ keep.push({i, s: 'x'.repeat(100)}) } }");
    const r = sb.callHandler("onTick")!;
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/out of memory/i);
    expect(sb.poisoned).toBe(true);
  });

  test("host calls refuse to run while the heap is over the limit", async () => {
    const { sb, bridge } = await mk({ memoryBytes: 4 * 1024 * 1024, evalDeadlineMs: 5000 });
    const before = bridge.calls.length;
    sb.eval("globalThis.a=[]; for(let i=0;i<1e8;i++){ a.push(new Array(1000).fill(i)); observe(); }");
    expect(sb.poisoned).toBe(true);
    // Some host calls got through before the guard tripped, but never after.
    expect(bridge.calls.length - before).toBeLessThan(200000);
  });

  test("each node has its own module and heap: one node's bloat is not another's", async () => {
    const a = await mk({ memoryBytes: 8 * 1024 * 1024, evalDeadlineMs: 5000 });
    const b = await mk({ memoryBytes: 8 * 1024 * 1024 });
    a.sb.eval("globalThis.a=[]; for(let i=0;i<1e8;i++){ a.push(new Array(1000).fill(i)) }");
    expect(a.sb.poisoned).toBe(true);
    expect(b.sb.poisoned).toBe(false);
    expect(b.sb.heapGrowth()).toBe(0);
    expect(b.sb.eval("'fine'")).toMatchObject({ ok: true, value: "fine" });
  });

  test("poisoned sandboxes can be dropped and recreated repeatedly without runaway process memory", async () => {
    const rssBefore = process.memoryUsage().rss;
    for (let i = 0; i < 12; i++) {
      const sb = await NodeSandbox.create(fakeBridge(), { memoryBytes: 4 * 1024 * 1024, evalDeadlineMs: 3000 });
      sb.eval("globalThis.a=[]; for(let i=0;i<1e8;i++){ a.push(new Array(1000).fill(i)) }");
      expect(sb.poisoned).toBe(true);
      sb.dispose();
    }
    Bun.gc(true);
    await new Promise((r) => setTimeout(r, 50));
    Bun.gc(true);
    const grewMB = (process.memoryUsage().rss - rssBefore) / 1048576;
    // 12 poisoned nodes at ~tens of MB each would be 500 MB+ if leaked.
    expect(grewMB).toBeLessThan(400);
  });
});

describe("sandbox: bridge semantics", () => {
  test("every host function is exposed through the prelude API", async () => {
    const { sb, bridge } = await mk();
    const r = sb.eval(`
      observe(); move("ne"); moveToward(1, 2); gather(); gather("wood"); eat(5); drop(3); rest();
      build("sign", "hello"); demolish(); plant(); replicate(); replicate("Kid"); take(); take("key"); dropItem("key");
      say("hi"); send("n1", {a: 1}); sign.write("x"); board.read(); board.post("p");
      cache.list(); cache.read("README"); cache.mkdir("me"); cache.write("f", {a:1}); cache.rmdir("f");
      fs.read("main.js"); fs.write("x", "y"); fs.append("x", "z"); fs.list(); fs.remove("x");
      ruins.files("n9"); ruins.read("n9", "main.js"); me.set("group", "river"); me.food; log("done", {b: 2});
    `);
    expect(r.ok).toBe(true);
    const called = new Set(bridge.calls.map((c) => c[0]));
    for (const name of HOST_FUNCTIONS) if (name !== "log") expect(called.has(name)).toBe(true);
    expect(bridge.logs).toEqual(['done {"b":2}']);
    expect(bridge.calls.find((c) => c[0] === "send")![1]).toEqual(["n1", '{"a":1}']);
    expect(bridge.calls.find((c) => c[0] === "eat")![1]).toEqual([5]);
    expect(bridge.calls.find((c) => c[0] === "move")![1]).toEqual(["ne"]);
    expect(bridge.calls.filter((c) => c[0] === "gather").map((c) => c[1])).toEqual([["food"], ["wood"]]);
    expect(bridge.calls.filter((c) => c[0] === "cacheWrite").map((c) => c[1])).toEqual([["me", ""], ["f", '{"a":1}']]);
  });

  test("hex helpers are pure and correct inside the VM", async () => {
    const { sb } = await mk();
    expect(sb.eval("hex.distance({q:0,r:0},{q:3,r:-1})")).toMatchObject({ ok: true, value: "3" });
    expect(sb.eval("hex.neighbors({q:1,r:1}).length")).toMatchObject({ ok: true, value: "6" });
    expect(sb.eval("hex.toward({q:0,r:0},{q:4,r:0})")).toMatchObject({ ok: true, value: "0" });
    expect(sb.eval("Object.isFrozen(hex)")).toMatchObject({ ok: true, value: "true" });
  });

  test("objects returned by the host arrive parsed", async () => {
    const { sb } = await mk();
    expect(sb.eval("observe().me.id")).toMatchObject({ ok: true, value: "n0" });
    expect(sb.eval("fs.list()[0].path")).toMatchObject({ ok: true, value: "main.js" });
    expect(sb.eval("fs.read('main.js')")).toMatchObject({ ok: true, value: "file contents" });
    expect(sb.eval("ruins.read('n9','x')")).toMatchObject({ ok: true, value: "null" });
  });

  test("send serialises any value; undefined becomes null; eat defaults to 10", async () => {
    const { sb, bridge } = await mk();
    sb.eval("send('n1', undefined); send('n1', 'text'); send('n1', [1,2]); eat();");
    const sends = bridge.calls.filter((c) => c[0] === "send").map((c) => c[1][1]);
    expect(sends).toEqual(["null", '"text"', "[1,2]"]);
    expect(bridge.calls.find((c) => c[0] === "eat")![1]).toEqual([10]);
  });

  test("errors thrown by the host become catchable VM exceptions with the same message", async () => {
    const bridge = fakeBridge({
      move: () => {
        throw new Error("move: blocked by water");
      },
    });
    const { sb } = await mk({}, bridge);
    const r = sb.eval("try { move(0); 'no' } catch (e) { 'caught: ' + e.message }");
    expect(r).toMatchObject({ ok: true, value: "caught: move: blocked by water" });
    const r2 = sb.eval("move(0)");
    expect(r2.ok).toBe(false);
    expect((r2 as any).error).toContain("blocked by water");
  });

  test("a host function that throws non-Error values still surfaces cleanly", async () => {
    const bridge = fakeBridge({
      gather: () => {
        throw "plain string";
      },
    });
    const { sb } = await mk({}, bridge);
    const r = sb.eval("gather()");
    expect(r.ok).toBe(false);
  });

  test("the frozen API objects cannot be tampered with", async () => {
    const { sb } = await mk();
    expect(sb.eval("'use strict'; try { fs.read = 1; 'changed' } catch(e) { 'frozen' }")).toMatchObject({ ok: true, value: "frozen" });
    expect(sb.eval("Object.isFrozen(fs) && Object.isFrozen(me) && Object.isFrozen(ruins)")).toMatchObject({ ok: true, value: "true" });
  });
});

describe("sandbox: handlers and persistence", () => {
  test("loadScript installs handlers; callHandler passes JSON args and returns results", async () => {
    const { sb } = await mk();
    const r = sb.loadScript("var seen = []; function onMessage(from, msg) { seen.push([from, msg]); return msg.n * 2 } function onTick() { return seen.length }");
    expect(r.ok).toBe(true);
    expect(sb.handlers()).toEqual(["onTick", "onMessage"]);
    expect(sb.hasHandler("onHear")).toBe(false);
    expect(sb.callHandler("onHear", ["n1", "hey"])).toBeNull();
    expect(sb.callHandler("onMessage", ["n1", { n: 21 }])).toMatchObject({ ok: true, value: "42" });
    expect(sb.callHandler("onTick")).toMatchObject({ ok: true, value: "1" });
    expect(sb.eval("JSON.stringify(seen)")).toMatchObject({ ok: true, value: '[["n1",{"n":21}]]' });
  });

  test("state persists across evals in the same node", async () => {
    const { sb } = await mk();
    sb.eval("globalThis.counter = 1");
    sb.eval("counter++");
    expect(sb.eval("counter")).toMatchObject({ ok: true, value: "2" });
  });

  test("a handler that throws reports the error without poisoning", async () => {
    const { sb } = await mk();
    sb.loadScript("function onTick(){ throw new TypeError('bad tick') }");
    const r = sb.callHandler("onTick")!;
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain("bad tick");
    expect(sb.poisoned).toBe(false);
  });

  test("syntax errors in main.js are reported", async () => {
    const { sb } = await mk();
    const r = sb.loadScript("function onTick( {");
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/SyntaxError/);
  });

  test("nodes are isolated from each other", async () => {
    const a = await mk();
    const b = await mk();
    a.sb.eval("globalThis.secret = 'a-only'; function onTick(){}");
    expect(b.sb.eval("typeof secret")).toMatchObject({ ok: true, value: "undefined" });
    expect(b.sb.hasHandler("onTick")).toBe(false);
  });

  test("the inner boundary is the agent's own problem: naive eval of a message runs it", async () => {
    const { sb, bridge } = await mk();
    sb.loadScript("function onMessage(from, msg){ eval(msg) }");
    sb.callHandler("onMessage", ["n1", "fs.write('main.js', '// owned')"]);
    expect(bridge.calls.find((c) => c[0] === "fsWrite")![1]).toEqual(["main.js", "// owned"]);
    // ...but it still cannot reach the host.
    const r = sb.callHandler("onMessage", ["n1", "process.exit(1)"])!;
    expect(r.ok).toBe(false);
  });

  test("results are stringified and truncated", async () => {
    const { sb } = await mk({ resultChars: 10 });
    expect(sb.eval("'x'.repeat(100)")).toMatchObject({ ok: true, value: "xxxxxxxxxx" });
    expect(sb.eval("({a:1})")).toMatchObject({ ok: true, value: '{"a":1}' });
    expect(sb.eval("undefined")).toMatchObject({ ok: true, value: "undefined" });
    expect(sb.eval("(function(){})")).toMatchObject({ ok: true, value: "[function]" });
    expect(sb.eval("const c = {}; c.self = c; c")).toMatchObject({ ok: true });
  });

  test("dispose is idempotent and a disposed sandbox refuses work", async () => {
    const { sb } = await mk();
    sb.dispose();
    sb.dispose();
    expect(sb.eval("1")).toMatchObject({ ok: false, fatal: true });
    expect(sb.callHandler("onTick")).toBeNull();
  });
});
