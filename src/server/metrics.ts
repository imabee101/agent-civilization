/**
 * Prometheus text exposition of the engine's numbers: pacing, the backend
 * profile, the last hour of turns, and event counts by kind. One scrape
 * beside llama-server's own /metrics tells where a turn's time goes.
 */
import type { BrainStatus, PacingStats } from "../shared/protocol";

export interface MetricsInput {
  pacing: PacingStats;
  brain: BrainStatus;
  living: number;
  tick: number;
  eventCounts: Record<string, number>;
}

export function renderMetrics(m: MetricsInput): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number, labels = "") => {
    lines.push(`# HELP agentciv_${name} ${help}`, `# TYPE agentciv_${name} gauge`, `agentciv_${name}${labels} ${Number.isFinite(value) ? value : 0}`);
  };
  const p = m.pacing;
  const w = p.window;
  gauge("tick", "World tick.", m.tick);
  gauge("living_nodes", "Living nodes.", m.living);
  gauge("paused", "1 while the world is paused.", p.paused ? 1 : 0);
  gauge("ticks_per_second", "World ticks per second at the current pace.", p.tps);
  gauge("turn_interval_ticks", "Ticks between two turns of one node, as scheduled.", p.turnIntervalTicks);
  gauge("turns_in_flight", "Model turns generating now.", p.inFlight);
  gauge("turns_queued", "Nodes waiting for a turn.", p.queued);
  gauge("concurrency", "Turns run at once right now.", p.concurrency);
  gauge("concurrency_ceiling", "The most turns ever run at once (--concurrency).", p.concurrencyCeiling);
  gauge("concurrency_best", "The level that measured the best throughput.", p.bestConcurrency);
  gauge("governed", "1 while the concurrency level is chosen by measured throughput.", p.governed ? 1 : 0);
  gauge("decisions_total", "Model turns since the engine started.", p.decisions);
  gauge("turn_latency_avg_ms", "Moving average of turn latency.", p.avgLatencyMs);
  gauge("turn_latency_p50_ms", "Median turn latency over the last hour.", w.latencyP50Ms);
  gauge("turn_latency_p90_ms", "90th percentile turn latency over the last hour.", w.latencyP90Ms);
  gauge("turns_last_hour", "Turns finished in the last hour.", w.turns);
  gauge("turns_per_node_per_hour", "Turns per living node per hour.", w.turnsPerNodePerHour);
  gauge("turn_prefill_seconds", "Mean seconds a turn spent in prompt processing (backend timings).", w.prefillSec);
  gauge("turn_decode_seconds", "Mean seconds a turn spent generating (backend timings).", w.decodeSec);
  gauge("turn_output_tokens", "Mean output tokens per turn.", w.outputTokens);
  gauge("turn_cut_ratio", "Share of turns cut at the token limit.", w.cutRate);
  gauge("turn_error_ratio", "Share of turns whose code threw or that failed at the brain.", w.errorRate);
  gauge("backend_prefill_tokens_per_second", "Prompt processing rate, moving average from backend timings.", p.prefillTps);
  gauge("backend_decode_tokens_per_second", "Generation rate, moving average from backend timings.", p.decodeTps);
  gauge("backend_cache_hit_ratio", "Share of prompt tokens the backend found in its cache.", p.cacheHit);
  gauge("brain_connected", "1 while the brain answers.", m.brain.connected ? 1 : 0);
  if (m.brain.profile) {
    const pr = m.brain.profile;
    gauge("backend_fast", "1 when the backend was classified as fast, 0 when bandwidth-bound.", pr.kind === "fast" ? 1 : 0, `{model="${(pr.modelFile ?? m.brain.model).replace(/"/g, "'")}"}`);
    gauge("backend_probe_prefill_tokens_per_second", "Single-stream prompt processing rate at the probe.", pr.prefillTps);
    gauge("backend_probe_decode_tokens_per_second", "Single-stream generation rate at the probe.", pr.decodeTps);
    if (pr.slots) gauge("backend_slots", "Server slots.", pr.slots);
  }
  gauge("sandbox_calls_total", "Handler and turn-code executions.", p.sandboxCalls);
  gauge("tick_cpu_avg_ms", "Average agent-code time per tick.", p.avgTickCpuMs);
  lines.push("# HELP agentciv_events_total Events recorded since the engine started, by kind.", "# TYPE agentciv_events_total counter");
  for (const kind of Object.keys(m.eventCounts).sort()) lines.push(`agentciv_events_total{kind="${kind}"} ${m.eventCounts[kind]}`);
  return lines.join("\n") + "\n";
}
