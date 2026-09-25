/**
 * One QuickJS sandbox per node.
 *
 * This is the outer boundary — the one place in the project where strictness
 * is the point. Agent code must never reach the host: no filesystem, no
 * network, no timers, no `require`, no Bun/Node globals. It gets exactly the
 * host bridge functions and nothing else, and every call is bounded by a
 * wall-clock deadline, a memory limit and a stack limit.
 *
 * Each node gets its own WASM module instance, so its heap is physically
 * separate from every other node's. A runtime that hits an out-of-memory
 * condition is marked poisoned and thrown away rather than disposed
 * (disposing after OOM can trip QuickJS assertions); the engine then rebuilds
 * the node from its files.
 */
import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { HANDLER_NAMES, HOST_FUNCTIONS, PRELUDE, type HandlerName, type HostBridge } from "./api";

export interface SandboxLimits {
  /**
   * Cap on the node's total heap growth (bytes above the module's initial
   * heap). Checked on every interrupt callback and every host call. This is
   * the real memory ceiling; see the note on `allocationBytes`.
   */
  memoryBytes: number;
  /**
   * QuickJS's own malloc limit. In this WASM build it reliably rejects any
   * single allocation larger than the limit but does not account for the sum
   * of many small ones, so it is a per-allocation cap, not a total.
   */
  allocationBytes: number;
  /** Max native stack for the interpreter. */
  stackBytes: number;
  /** Wall-clock budget for one handler call (onTick / onMessage / onHear). */
  handlerDeadlineMs: number;
  /** Wall-clock budget for evaluating turn code or main.js. */
  evalDeadlineMs: number;
  /** Max chars of a stringified result kept for display. */
  resultChars: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 32 * 1024 * 1024,
  allocationBytes: 4 * 1024 * 1024,
  stackBytes: 512 * 1024,
  handlerDeadlineMs: 25,
  evalDeadlineMs: 250,
  resultChars: 400,
};

export type SandboxResult = { ok: true; value: string; ms: number } | { ok: false; error: string; ms: number; fatal?: boolean };

export type HostFunctionName = (typeof HOST_FUNCTIONS)[number];

export class NodeSandbox {
  private module: QuickJSWASMModule;
  private runtime: QuickJSRuntime;
  private vm: QuickJSContext;
  readonly limits: SandboxLimits;
  /** True once the runtime can no longer be trusted (OOM / internal error). */
  poisoned = false;
  private disposed = false;
  /** Number of host bridge calls made by this node's code, for stats. */
  hostCalls = 0;
  private readonly initialHeap: number;
  private readonly heapLimit: number;
  /** Set by the interrupt handler when the heap guard trips. */
  private heapTripped = false;

  private constructor(module: QuickJSWASMModule, bridge: HostBridge, limits: SandboxLimits) {
    this.module = module;
    this.limits = limits;
    this.initialHeap = this.heapBytes();
    this.heapLimit = this.initialHeap + limits.memoryBytes;
    this.runtime = module.newRuntime();
    this.runtime.setMemoryLimit(limits.allocationBytes);
    this.runtime.setMaxStackSize(limits.stackBytes);
    this.vm = this.runtime.newContext();
    this.installBridge(bridge);
    const r = this.evalRaw(PRELUDE, "prelude.js", limits.evalDeadlineMs);
    if (!r.ok) throw new Error(`sandbox prelude failed: ${r.error}`);
  }

  static async create(bridge: HostBridge, limits: Partial<SandboxLimits> = {}): Promise<NodeSandbox> {
    const module = await newQuickJSWASMModuleFromVariant(variant);
    return new NodeSandbox(module, bridge, { ...DEFAULT_SANDBOX_LIMITS, ...limits });
  }

  // ------------------------------------------------------------- memory

  /** Size of this node's WASM heap. Each node has its own module, so this is its memory alone. */
  heapBytes(): number {
    const em = (this.module as unknown as { module?: { HEAPU8?: Uint8Array } }).module;
    return em?.HEAPU8?.buffer.byteLength ?? 0;
  }

  /** Heap growth caused by this node's code, in bytes. */
  heapGrowth(): number {
    return Math.max(0, this.heapBytes() - this.initialHeap);
  }

  private overHeapLimit(): boolean {
    return this.heapBytes() > this.heapLimit;
  }

  /** Interrupt handler: stops the interpreter at a deadline or when the heap guard trips. */
  private guard(deadline: number): () => boolean {
    return () => {
      if (this.overHeapLimit()) {
        this.heapTripped = true;
        return true;
      }
      return Date.now() > deadline;
    };
  }

  // ------------------------------------------------------------- bridge

  private installBridge(bridge: HostBridge): void {
    const vm = this.vm;
    const host = vm.newObject();
    for (const name of HOST_FUNCTIONS) {
      const fn = vm.newFunction(name, (...args: QuickJSHandle[]) => {
        this.hostCalls++;
        if (this.overHeapLimit()) {
          this.heapTripped = true;
          throw new Error("out of memory");
        }
        const plain = args.map((h) => this.toPlain(h));
        // Any exception thrown here becomes an exception inside the VM.
        const impl = bridge[name] as (...a: unknown[]) => unknown;
        const result = impl.apply(bridge, plain);
        return this.fromPlain(result);
      });
      vm.setProp(host, name, fn);
      fn.dispose();
    }
    vm.setProp(vm.global, "__host", host);
    host.dispose();
  }

  /** Convert a VM handle to a plain JS primitive (objects are stringified). */
  private toPlain(h: QuickJSHandle): unknown {
    const t = this.vm.typeof(h);
    switch (t) {
      case "string":
        return this.vm.getString(h);
      case "number":
        return this.vm.getNumber(h);
      case "boolean":
        return this.vm.dump(h) as boolean;
      case "undefined":
        return undefined;
      case "object":
        if (this.vm.dump(h) === null) return null;
        return this.vm.dump(h);
      default:
        return this.vm.dump(h);
    }
  }

  private fromPlain(v: unknown): QuickJSHandle {
    const vm = this.vm;
    if (v === undefined) return vm.undefined;
    if (v === null) return vm.null;
    if (typeof v === "string") return vm.newString(v);
    if (typeof v === "number") return vm.newNumber(v);
    if (typeof v === "boolean") return v ? vm.true : vm.false;
    // Objects cross the boundary as JSON text; the prelude parses them.
    return vm.newString(JSON.stringify(v));
  }

  // --------------------------------------------------------------- eval

  private evalRaw(code: string, filename: string, deadlineMs: number): SandboxResult {
    if (this.poisoned) return { ok: false, error: "sandbox is poisoned", ms: 0, fatal: true };
    if (this.disposed) return { ok: false, error: "sandbox disposed", ms: 0, fatal: true };
    const t0 = performance.now();
    this.heapTripped = false;
    this.runtime.setInterruptHandler(this.guard(Date.now() + deadlineMs));
    try {
      const r = this.vm.evalCode(code, filename, { type: "global" });
      const ms = performance.now() - t0;
      if (r.error) {
        const err = this.describeError(r.error);
        r.error.dispose();
        return this.classify(err, ms);
      }
      const value = this.describeValue(r.value);
      r.value.dispose();
      return { ok: true, value, ms };
    } catch (e) {
      // Errors escaping the interpreter itself (e.g. WASM aborts) poison the node.
      this.poisoned = true;
      return { ok: false, error: `fatal: ${(e as Error).message ?? String(e)}`, ms: performance.now() - t0, fatal: true };
    } finally {
      this.runtime.removeInterruptHandler();
    }
  }

  private classify(err: string, ms: number): SandboxResult {
    if (this.heapTripped) {
      this.poisoned = true;
      return { ok: false, error: `InternalError: out of memory (heap limit ${this.limits.memoryBytes} bytes)`, ms, fatal: true };
    }
    if (/out of memory/i.test(err)) {
      this.poisoned = true;
      return { ok: false, error: err, ms, fatal: true };
    }
    return { ok: false, error: err, ms };
  }

  private describeError(h: QuickJSHandle): string {
    try {
      const e = this.vm.dump(h) as { name?: string; message?: string; stack?: string } | string;
      if (typeof e === "string") return e;
      const name = e?.name ?? "Error";
      const message = e?.message ?? "";
      const stackLine = (e?.stack ?? "").split("\n").find((l) => l.trim().length > 0)?.trim();
      const text = `${name}: ${message}`;
      return stackLine && !/^\s*at <eval>/.test(stackLine) ? `${text} (${stackLine.slice(0, 120)})` : text;
    } catch {
      return "Error: <unprintable>";
    }
  }

  private describeValue(h: QuickJSHandle): string {
    try {
      const t = this.vm.typeof(h);
      if (t === "undefined") return "undefined";
      if (t === "function") return "[function]";
      const v = this.vm.dump(h);
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return (s ?? String(v)).slice(0, this.limits.resultChars);
    } catch {
      return "[unprintable]";
    }
  }

  /** Evaluate turn code produced by the model, or any ad-hoc code. */
  eval(code: string, filename = "turn.js"): SandboxResult {
    return this.evalRaw(code, filename, this.limits.evalDeadlineMs);
  }

  /** (Re)load the node's persistent script. Handlers it defines become globals. */
  loadScript(source: string): SandboxResult {
    return this.evalRaw(source, "main.js", this.limits.evalDeadlineMs);
  }

  hasHandler(name: HandlerName): boolean {
    if (this.poisoned || this.disposed) return false;
    const h = this.vm.getProp(this.vm.global, name);
    const isFn = this.vm.typeof(h) === "function";
    h.dispose();
    return isFn;
  }

  handlers(): HandlerName[] {
    return HANDLER_NAMES.filter((n) => this.hasHandler(n));
  }

  /** Call a global handler with JSON-safe arguments under the handler deadline. */
  callHandler(name: HandlerName, args: unknown[] = []): SandboxResult | null {
    if (!this.hasHandler(name)) return null;
    const t0 = performance.now();
    const vm = this.vm;
    const fn = vm.getProp(vm.global, name);
    const handles: QuickJSHandle[] = [];
    try {
      for (const a of args) handles.push(this.jsonToHandle(a));
      this.heapTripped = false;
      this.runtime.setInterruptHandler(this.guard(Date.now() + this.limits.handlerDeadlineMs));
      const r = vm.callFunction(fn, vm.undefined, ...handles);
      const ms = performance.now() - t0;
      if (r.error) {
        const err = this.describeError(r.error);
        r.error.dispose();
        return this.classify(err, ms);
      }
      const value = this.describeValue(r.value);
      r.value.dispose();
      return { ok: true, value, ms };
    } catch (e) {
      this.poisoned = true;
      return { ok: false, error: `fatal: ${(e as Error).message ?? String(e)}`, ms: performance.now() - t0, fatal: true };
    } finally {
      this.runtime.removeInterruptHandler();
      for (const h of handles) h.dispose();
      fn.dispose();
    }
  }

  private jsonToHandle(v: unknown): QuickJSHandle {
    const vm = this.vm;
    if (v === undefined) return vm.undefined;
    if (v === null) return vm.null;
    if (typeof v === "string") return vm.newString(v);
    if (typeof v === "number") return vm.newNumber(v);
    if (typeof v === "boolean") return v ? vm.true : vm.false;
    const json = JSON.stringify(v);
    const r = vm.evalCode(`JSON.parse(${JSON.stringify(json)})`, "args.js");
    if (r.error) {
      r.error.dispose();
      return vm.null;
    }
    return r.value;
  }

  /** Bytes currently allocated in this node's heap. */
  memoryUsed(): number {
    if (this.poisoned || this.disposed) return 0;
    const h = this.runtime.computeMemoryUsage();
    const u = this.vm.dump(h) as { memory_used_size?: number; malloc_size?: number };
    h.dispose();
    return u.memory_used_size ?? u.malloc_size ?? 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.poisoned) return; // never touch a poisoned runtime; let GC reclaim the module
    try {
      this.vm.dispose();
      this.runtime.dispose();
    } catch {
      // A dispose failure is not worth crashing over; the module will be GC'd.
    }
  }
}
