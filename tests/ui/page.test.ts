import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../ui/index.html", import.meta.url), "utf8");

describe("the page", () => {
  test("shows the scene strip and asks before starting over, and does not offer rewind", () => {
    expect(html).toContain('id="sceneStrip"');
    expect(html).toContain("Are you sure?");
    expect(html).toContain("keep the world");
    expect(html).toContain("start over");
    expect(html.toLowerCase()).not.toContain("rewind");
  });

  test("declares accessible disclosure controls for dense panels", () => {
    const keys = ["dossier.status", "dossier.inventory", "dossier.profile", "dossier.thought", "hood.decisions", "hood.nodes", "hood.pacing", "hood.alerts", "hood.lineages"];
    for (const key of keys) expect(html).toContain(`data-disclosure-key="${key}"`);
    expect(html).toContain('id="groupsVisibility"');
    expect(html).toContain('id="chronicleVisibility"');
    expect(html).toContain('aria-controls="tabBrain"');
  });
});
