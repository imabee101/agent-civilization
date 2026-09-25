/**
 * Timestamped copies of the snapshot file, rotated. Scheduled with Bun.cron
 * when available (Bun >= 1.4); callable directly otherwise.
 */
import { mkdir, readdir, unlink, copyFile } from "node:fs/promises";

export interface BackupOptions {
  snapshotPath: string;
  dir: string;
  keep: number;
  now?: () => Date;
}

export function backupName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `world-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}.json`;
}

/** Copy the current snapshot into the backup dir and prune old ones. Returns the new file, or undefined if there is no snapshot yet. */
export async function backupSnapshot(opts: BackupOptions): Promise<string | undefined> {
  const src = Bun.file(opts.snapshotPath);
  if (!(await src.exists())) return undefined;
  await mkdir(opts.dir, { recursive: true });
  const name = backupName((opts.now ?? (() => new Date()))());
  const dest = `${opts.dir}/${name}`;
  await copyFile(opts.snapshotPath, dest);
  const files = (await readdir(opts.dir)).filter((f) => /^world-\d{8}-\d{4}\.json$/.test(f)).sort();
  const excess = files.length - Math.max(1, opts.keep);
  for (let i = 0; i < excess; i++) await unlink(`${opts.dir}/${files[i]}`);
  return dest;
}

/** Schedule hourly backups with Bun.cron if this Bun has it; returns a stop function. */
export function scheduleBackups(opts: BackupOptions, cronExpr = "7 * * * *", log: (m: string) => void = () => {}): () => void {
  const cron = (Bun as unknown as { cron?: (expr: string, fn: () => void | Promise<void>) => { stop?: () => void; unref?: () => void } | void }).cron;
  if (typeof cron !== "function") {
    // Older Bun: fall back to a plain interval (hourly).
    const t = setInterval(() => void backupSnapshot(opts).then((f) => f && log(`backup written: ${f}`)), 60 * 60 * 1000);
    return () => clearInterval(t);
  }
  const job = cron(cronExpr, async () => {
    const f = await backupSnapshot(opts);
    if (f) log(`backup written: ${f}`);
  });
  return () => {
    if (job && typeof job === "object" && typeof job.stop === "function") job.stop();
  };
}
