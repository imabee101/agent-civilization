#!/usr/bin/env bun
/**
 * What a record of turns says. Reads history.sqlite or a running game's API.
 *
 *   bun scripts/report.ts /var/lib/agent-civ/history.sqlite
 *   bun scripts/report.ts https://civ.imabee.com [--insecure]
 *   bun scripts/report.ts data/history.sqlite --hours 2   (only the last 2 hours of decisions)
 */
import { HistoryStore } from "../src/engine/history";
import { formatReport, summarize } from "../src/engine/report";
import type { DecisionRecord, WorldEvent } from "../src/shared/protocol";

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--"));
if (!source) {
  console.error("usage: bun scripts/report.ts <history.sqlite | https://host> [--hours N] [--insecure]");
  process.exit(2);
}
const hoursArg = args.indexOf("--hours");
const hours = hoursArg >= 0 ? Number(args[hoursArg + 1]) : undefined;
const insecure = args.includes("--insecure");

async function fromApi(base: string): Promise<{ decisions: DecisionRecord[]; events: WorldEvent[] }> {
  const get = async (path: string) => {
    const r = await fetch(base.replace(/\/+$/, "") + path, insecure ? ({ tls: { rejectUnauthorized: false } } as RequestInit) : undefined);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return (await r.json()) as unknown[];
  };
  const page = async <T extends { id: number }>(path: string, limit: number, max: number): Promise<T[]> => {
    const all: T[] = [];
    let before: number | undefined;
    while (all.length < max) {
      const rows = (await get(`${path}?limit=${limit}${before ? `&before=${before}` : ""}`)) as T[];
      if (!rows.length) break;
      all.unshift(...rows);
      before = rows[0]!.id;
      if (rows.length < limit) break;
    }
    return all;
  };
  return { decisions: await page<DecisionRecord>("/api/history/decisions", 500, 20_000), events: await page<WorldEvent>("/api/history/events", 1000, 100_000) };
}

function fromFile(path: string): { decisions: DecisionRecord[]; events: WorldEvent[] } {
  const h = new HistoryStore(path);
  const decisions: DecisionRecord[] = [];
  let before: number | undefined;
  for (;;) {
    const rows = h.decisions({ limit: 500, before });
    if (!rows.length) break;
    decisions.unshift(...rows);
    before = rows[0]!.id;
    if (rows.length < 500) break;
  }
  const events: WorldEvent[] = [];
  before = undefined;
  for (let i = 0; i < 200; i++) {
    const rows = h.events({ limit: 1000, before });
    if (!rows.length) break;
    events.unshift(...rows);
    before = rows[0]!.id;
    if (rows.length < 1000) break;
  }
  h.close();
  return { decisions, events };
}

let { decisions, events } = /^https?:/.test(source) ? await fromApi(source) : fromFile(source);
if (hours && Number.isFinite(hours) && decisions.length) {
  const cutoff = Math.max(...decisions.map((d) => d.finishedAt)) - hours * 3_600_000;
  decisions = decisions.filter((d) => d.finishedAt >= cutoff);
  const firstTick = Math.min(...decisions.map((d) => d.tick));
  events = events.filter((e) => e.tick >= firstTick);
}
console.log(formatReport(summarize(decisions, events)));
