import { describe, expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { backupName, backupSnapshot, scheduleBackups } from "../../src/engine/backups";

describe("backups", () => {
  test("backupName is UTC and sortable", () => {
    expect(backupName(new Date(Date.UTC(2026, 8, 25, 7, 3)))).toBe("world-20260925-0703.json");
  });

  test("copies the snapshot and rotates old backups", async () => {
    const dir = `${import.meta.dir}/../../scratch/backups-${Date.now()}`;
    await mkdir(dir, { recursive: true });
    const snap = `${dir}/world.json`;
    expect(await backupSnapshot({ snapshotPath: snap, dir: `${dir}/b`, keep: 2 })).toBeUndefined();
    await Bun.write(snap, '{"v":1}');
    let hour = 0;
    const now = () => new Date(Date.UTC(2026, 0, 1, hour++));
    const first = await backupSnapshot({ snapshotPath: snap, dir: `${dir}/b`, keep: 2, now });
    expect(first).toEndWith("world-20260101-0000.json");
    await backupSnapshot({ snapshotPath: snap, dir: `${dir}/b`, keep: 2, now });
    await backupSnapshot({ snapshotPath: snap, dir: `${dir}/b`, keep: 2, now });
    const files = (await readdir(`${dir}/b`)).sort();
    expect(files).toEqual(["world-20260101-0100.json", "world-20260101-0200.json"]);
    expect(await Bun.file(`${dir}/b/world-20260101-0200.json`).text()).toBe('{"v":1}');
    await rm(dir, { recursive: true, force: true });
  });

  test("scheduleBackups returns a stop function on any Bun", () => {
    const stop = scheduleBackups({ snapshotPath: "/nonexistent/x.json", dir: "/nonexistent/b", keep: 1 }, "0 0 1 1 *");
    expect(typeof stop).toBe("function");
    stop();
  });
});
