import { describe, expect, test } from "bun:test";
import { Pacing, TRIAL_TURNS, dueIn } from "../../src/engine/pacing";

describe("dueIn", () => {
  test("hot halves the interval, cold triples it, never under one tick", () => {
    expect(dueIn(16, "hot")).toBe(8);
    expect(dueIn(16, "warm")).toBe(16);
    expect(dueIn(16, "cold")).toBe(48);
    expect(dueIn(1, "hot")).toBe(1);
    expect(dueIn(5, "hot")).toBe(3);
  });
});

describe("Pacing", () => {
  test("EMA latency and decisions per minute", () => {
    const p = new Pacing({ tickMs: 500, turnIntervalTicks: 10, concurrency: 1, maxTickMs: 0 });
    p.recordDecision(1000, 20, 1000);
    expect(p.avgLatencyMs).toBe(1000);
    p.recordDecision(2000, 30, 2000);
    expect(p.avgLatencyMs).toBeCloseTo(1200, 5);
    expect(p.avgTokensPerSec).toBeCloseTo(22, 5);
    expect(p.decisionsPerMin(2000)).toBe(2);
    expect(p.decisionsPerMin(70_000)).toBe(0);
    p.recordDecision(500, 0, 3000);
    expect(p.avgTokensPerSec).toBeCloseTo(22, 5); // zero tps ignored
  });

  test("realtime when the brain keeps up, queued when it cannot", () => {
    const p = new Pacing({ tickMs: 500, turnIntervalTicks: 10, concurrency: 1, maxTickMs: 0 });
    // Unknown latency: desired interval.
    expect(p.effectiveTurnInterval(6, 1)).toBe(10);
    expect(p.mode(6, 1)).toBe("realtime");
    // 200 ms per decision, 6 nodes => 1.2 s per round => 3 ticks (< 10): realtime.
    p.recordDecision(200, 10);
    expect(p.effectiveTurnInterval(6, 1)).toBe(10);
    expect(p.mode(6, 1)).toBe("realtime");
    // 4 s per decision, 6 nodes => 24 s per round => 48 ticks at 1x: queued.
    const slow = new Pacing({ tickMs: 500, turnIntervalTicks: 10, concurrency: 1, maxTickMs: 0 });
    slow.recordDecision(4000, 5);
    expect(slow.effectiveTurnInterval(6, 1)).toBe(48);
    expect(slow.mode(6, 1)).toBe("queued");
    // Faster world clock stretches the interval in ticks.
    expect(slow.effectiveTurnInterval(6, 4)).toBe(192);
    // More concurrency shortens it.
    const par = new Pacing({ tickMs: 500, turnIntervalTicks: 10, concurrency: 4, maxTickMs: 0 });
    par.recordDecision(4000, 5);
    expect(par.effectiveTurnInterval(6, 1)).toBe(12);
    expect(slow.mode(0, 1)).toBe("idle");
  });

  test("stats snapshot", () => {
    const p = new Pacing({ tickMs: 250, turnIntervalTicks: 8, concurrency: 2, maxTickMs: 0 });
    p.recordDecision(300, 12.34, 5000);
    p.recordTickCpu(1.5);
    p.sandboxCalls = 9;
    const s = p.stats({ livingNodes: 3, speed: 2, paused: false, now: 6000 });
    expect(s.tps).toBe(8);
    expect(s.speed).toBe(2);
    expect(s.avgLatencyMs).toBe(300);
    expect(s.avgTokensPerSec).toBe(12.3);
    expect(s.avgTickCpuMs).toBe(1.5);
    expect(s.sandboxCalls).toBe(9);
    expect(s.decisions).toBe(1);
    expect(s.decisionsPerMin).toBe(1);
    expect(s.mode).toBe("realtime");
    expect(p.stats({ livingNodes: 3, speed: 2, paused: true }).mode).toBe("idle");
    expect(p.stats({ livingNodes: 3, speed: 2, paused: true }).tps).toBe(0);
  });

  test("paced: a slow brain slows the clock, not the turn interval, up to the cap", () => {
    const p = new Pacing({ tickMs: 500, turnIntervalTicks: 16, concurrency: 1, maxTickMs: 5000 });
    p.recordDecision(7000, 30);
    // 7 s x 6 nodes / 16 ticks = 2625 ms per tick
    expect(p.tickMsAt(1, 6)).toBe(2625);
    expect(p.effectiveTurnInterval(6, 1)).toBe(16);
    expect(p.mode(6, 1)).toBe("paced");
    // 64 nodes would need 28 s ticks; the cap holds at 5 s and turns space out instead
    expect(p.tickMsAt(1, 64)).toBe(5000);
    expect(p.effectiveTurnInterval(64, 1)).toBe(90);
    expect(p.mode(64, 1)).toBe("queued");
    expect(p.tickMsAt(1, 0)).toBe(500);
  });

  test("a call still in flight paces the clock by its elapsed time before any average exists", () => {
    const p = new Pacing({ tickMs: 500, turnIntervalTicks: 16, concurrency: 1, maxTickMs: 5000 });
    expect(p.tickMsAt(1, 6, 1000)).toBe(500);
    p.beginDecision(1000);
    expect(p.inFlight).toBe(1);
    // 40 s in: plan as if latency were 40 s -> 40000 * 6 / 16 = 15 s, capped at 5 s
    expect(p.tickMsAt(1, 6, 41_000)).toBe(5000);
    p.endDecision(1000);
    expect(p.inFlight).toBe(0);
    expect(p.tickMsAt(1, 6, 41_000)).toBe(500);
  });
});

describe("concurrency controller", () => {
  // Latency per turn at a level, chosen so that per-stream rate x level says: level 1 best, 2 worse, 3 worst.
  const latencyAt = (level: number) => ({ 1: 29_000, 2: 60_000, 3: 104_000 })[level]!;
  const run = (p: Pacing, turns: number) => {
    for (let i = 0; i < turns; i++) {
      const level = p.concurrency;
      p.recordDecision(latencyAt(level), 10, 1000 * i, { tokens: 300, level });
    }
  };

  test("bandwidth-bound: starts at one, tries the level above once, comes back when it measured worse", () => {
    const p = new Pacing({ tickMs: 500, turnIntervalTicks: 16, concurrency: 3, maxTickMs: 5000 });
    p.setBackendKind("bandwidth-bound");
    expect(p.concurrency).toBe(1);
    expect(p.governed).toBe(true);
    run(p, TRIAL_TURNS);
    expect(p.concurrency).toBe(2); // untested above: try it
    run(p, TRIAL_TURNS);
    expect(p.concurrency).toBe(1); // 2 x 5 tok/s < 1 x 10.3 tok/s
    expect(p.bestConcurrency).toBe(1);
    run(p, TRIAL_TURNS);
    expect(p.concurrency).toBe(1); // level 2 is known to be worse: stays
    expect(p.stats({ livingNodes: 12, speed: 1, paused: false, now: 0 })).toMatchObject({ concurrency: 1, concurrencyCeiling: 3, governed: true });
  });

  test("bandwidth-bound: climbs while each level measures better, and pacing uses the level in use", () => {
    const p = new Pacing({ tickMs: 500, turnIntervalTicks: 16, concurrency: 3, maxTickMs: 0 });
    expect(p.governed).toBe(false); // unmeasured: the ceiling, as before
    p.setBackendKind("bandwidth-bound");
    // A backend where parallel streams cost nothing: the same latency at every level.
    for (let i = 0; i < TRIAL_TURNS * 3; i++) {
      const level = p.concurrency;
      p.recordDecision(30_000, 10, 1000 * i, { tokens: 300, level });
    }
    expect(p.concurrency).toBe(3);
    expect(p.levelThroughput(3)).toBeCloseTo(30, 5);
    // Turn interval for 12 nodes at 30 s per turn: three at once means a third of the round.
    expect(p.effectiveTurnInterval(12, 1)).toBe(Math.ceil((30_000 * 12) / 3 / 500));
  });

  test("a fast backend, or one that keeps up in real time, takes the ceiling and is not governed", () => {
    const fast = new Pacing({ tickMs: 500, turnIntervalTicks: 16, concurrency: 4, maxTickMs: 5000 });
    fast.setBackendKind("fast");
    expect(fast.concurrency).toBe(4);
    expect(fast.governed).toBe(false);
    const keeps = new Pacing({ tickMs: 500, turnIntervalTicks: 16, concurrency: 4, maxTickMs: 5000 });
    keeps.setBackendKind("bandwidth-bound");
    keeps.recordDecision(5_000, 40, 0, { tokens: 200, level: 1 }); // 5 s < 16 ticks x 500 ms
    expect(keeps.keepsUp()).toBe(true);
    expect(keeps.governed).toBe(false);
    expect(keeps.concurrency).toBe(4);
    keeps.recordDecision(60_000, 4, 1000, { tokens: 200, level: 4 }); // overruns: governed again, at the level it climbed to (1)
    expect(keeps.governed).toBe(true);
    expect(keeps.concurrency).toBe(1);
  });

  test("timings feed prefill, decode and cache-hit averages", () => {
    const p = new Pacing({ tickMs: 500, turnIntervalTicks: 16, concurrency: 1, maxTickMs: 0 });
    p.recordTimings({ promptTokens: 2000, cachedTokens: 1300, promptMs: 7000, outputTokens: 300, outputMs: 15_000 });
    const s = p.stats({ livingNodes: 1, speed: 1, paused: false, now: 0 });
    expect(s.prefillTps).toBe(100);
    expect(s.decodeTps).toBe(20);
    expect(s.cacheHit).toBe(0.65);
  });
});
