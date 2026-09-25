import { describe, expect, test } from "bun:test";
import { HELP, parseArgs } from "../../src/config";

describe("parseArgs", () => {
  test("defaults", () => {
    const c = parseArgs([], {});
    expect(c.port).toBe(3000);
    expect(c.hostname).toBe("0.0.0.0");
    expect(c.dataDir).toBe("./data");
    expect(c.fresh).toBe(false);
    expect(c.help).toBe(false);
    expect(c.engine.world).toEqual({});
    expect(c.brain.kind).toBeUndefined();
  });

  test("flags in both --k v and --k=v forms, and booleans", () => {
    const c = parseArgs(["--port", "8080", "--agents=9", "--fresh", "--seed", "42", "--radius", "100", "--brain", "llamacpp", "--base-url=http://gpu:8080", "--model", "tiny", "--no-stream", "--prompt-format", "llama3", "--tick-ms", "250", "--concurrency", "2", "--max-tokens", "123"], {});
    expect(c.port).toBe(8080);
    expect(c.engine.initialAgents).toBe(9);
    expect(c.fresh).toBe(true);
    expect(c.engine.world?.seed).toBe(42);
    expect(c.engine.world?.mapRadius).toBe(40); // clamped
    expect(c.brain).toMatchObject({ kind: "llamacpp", baseUrl: "http://gpu:8080", model: "tiny", stream: false, promptFormat: "llama3", maxTokens: 123 });
    expect(c.engine.tickMs).toBe(250);
    expect(c.engine.concurrency).toBe(2);
  });

  test("environment fallbacks and CLI precedence", () => {
    const env = { PORT: "4000", AGENTCIV_BRAIN: "ollama", AGENTCIV_MODEL: "envmodel", AGENTCIV_AGENTS: "3", AGENTCIV_DATA: "/tmp/x" };
    const c = parseArgs([], env);
    expect(c.port).toBe(4000);
    expect(c.brain.kind).toBe("ollama");
    expect(c.brain.model).toBe("envmodel");
    expect(c.engine.initialAgents).toBe(3);
    expect(c.dataDir).toBe("/tmp/x");
    const d = parseArgs(["--port", "1", "--model", "cli"], env);
    expect(d.port).toBe(1);
    expect(d.brain.model).toBe("cli");
  });

  test("help flag and ignored junk", () => {
    expect(parseArgs(["-h"], {}).help).toBe(true);
    expect(parseArgs(["--help"], {}).help).toBe(true);
    expect(parseArgs(["positional", "--port", "notanumber"], {}).port).toBe(3000);
    expect(HELP).toContain("--brain");
  });
});
