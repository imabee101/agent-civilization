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
});
