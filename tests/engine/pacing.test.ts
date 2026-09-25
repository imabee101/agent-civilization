import { describe, expect, test } from "bun:test";
import { Pacing } from "../../src/engine/pacing";

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
