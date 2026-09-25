import index from "../ui/index.html";
import { resolveBrain } from "./brain/registry";
import { HELP, parseArgs } from "./config";
import { scheduleBackups } from "./engine/backups";
import { Engine } from "./engine/engine";
import { HistoryStore } from "./engine/history";
import { createApp } from "./server/app";

const cfg = parseArgs(process.argv.slice(2));
if (cfg.help) {
  console.log(HELP);
  process.exit(0);
}

const log = (msg: string) => console.log(`[agentciv] ${msg}`);

const { mkdir } = await import("node:fs/promises");
await mkdir(cfg.dataDir, { recursive: true });
const snapshotPath = `${cfg.dataDir}/world.json`;

const { brain, autodetected } = await resolveBrain(cfg.brain, { log });
log(`brain: ${brain.kind}${brain.model ? ` (${brain.model})` : ""}${brain.baseUrl ? ` at ${brain.baseUrl}` : ""}${autodetected ? " [auto]" : ""}`);

let engine: Engine;
const saved = cfg.fresh ? undefined : await Engine.loadSnapshot(snapshotPath);
if (saved) {
  engine = await Engine.fromSnapshot(saved, brain, { ...cfg.engine, snapshotPath });
  log(`restored world from ${snapshotPath} (tick ${engine.world.tick}, ${engine.world.livingAgents().length} living, ${engine.world.deadAgents().length} ruins)`);
} else {
  engine = new Engine(brain, { ...cfg.engine, snapshotPath });
  await engine.init();
  log(`new world (seed ${engine.world.config.seed}, ${engine.world.livingAgents().length} nodes)`);
}

if (cfg.history) {
  engine.history = new HistoryStore(`${cfg.dataDir}/history.sqlite`);
  log(`history: ${cfg.dataDir}/history.sqlite (${engine.history.stats().events} events so far)`);
}
const stopBackups = scheduleBackups({ snapshotPath, dir: `${cfg.dataDir}/backups`, keep: cfg.backupsToKeep }, "7 * * * *", log);

let operatorToken = cfg.operatorToken;
if (cfg.operatorTokenFile) {
  operatorToken = (await Bun.file(cfg.operatorTokenFile).text()).trim();
  if (!operatorToken) {
    log(`operator token file ${cfg.operatorTokenFile} is empty`);
    process.exit(1);
  }
}
log(operatorToken ? "operator token required on every control" : "no operator token: anyone who can reach the server holds the switch");
const app = createApp({ engine, port: cfg.port, hostname: cfg.hostname, tls: cfg.tls, index, log, operatorToken });
engine.start();
log(`listening on ${cfg.tls ? "https" : "http"}://${cfg.hostname === "0.0.0.0" ? "localhost" : cfg.hostname}:${app.server.port}`);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: saving snapshot and shutting down`);
  // A step that hangs (a socket that never closes, a stream that never ends) must not hold the
  // process past what systemd allows; the snapshot is the only thing worth waiting for.
  let step = "snapshot";
  const deadline = setTimeout(() => {
    log(`shutdown: still in "${step}" after 10 s; exiting anyway`);
    process.exit(0);
  }, 10_000);
  deadline.unref();
  try {
    await engine.saveSnapshot();
  } catch (e) {
    log(`snapshot failed: ${(e as Error).message}`);
  }
  step = "backups";
  stopBackups();
  step = "engine";
  await engine.shutdown();
  step = "history";
  engine.history?.close();
  step = "server";
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
