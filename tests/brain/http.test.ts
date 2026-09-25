import { describe, expect, test } from "bun:test";
import { joinUrl, postJson, readLines, readNdjson, readSse } from "../../src/brain/http";
import { BrainError } from "../../src/brain/types";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("stream readers", () => {
  test("readLines handles chunk boundaries mid-line and CRLF", async () => {
    const lines = await collect(readLines(streamOf(["ab", "c\r\nde", "f\n", "gh"])));
    expect(lines).toEqual(["abc", "def", "gh"]);
  });

  test("readLines on null body yields nothing", async () => {
    expect(await collect(readLines(null))).toEqual([]);
  });

  test("readSse parses data lines, skips comments/blank/malformed, stops at [DONE]", async () => {
    const body = streamOf([': comment\n\ndata: {"a":1}\n\ndata: not json\n\ndata: {"a":', '2}\n\ndata: [DONE]\n\ndata: {"a":3}\n']);
    expect(await collect(readSse(body))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("readNdjson parses each line", async () => {
    const body = streamOf(['{"x":1}\n{"x"', ':2}\n\nbroken\n{"x":3}']);
    expect(await collect(readNdjson(body))).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
  });

  test("joinUrl normalises slashes", () => {
    expect(joinUrl("http://h/v1/", "/chat/completions")).toBe("http://h/v1/chat/completions");
    expect(joinUrl("http://h", "x")).toBe("http://h/x");
  });
});

describe("postJson", () => {
  test("sends JSON with headers and returns the response", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init! };
      return new Response("ok", { status: 200 });
    };
    const res = await postJson("http://x/y", { a: 1 }, { fetch: fakeFetch, timeoutMs: 1000, headers: { authorization: "Bearer k" } });
    expect(await res.text()).toBe("ok");
    expect(seen!.url).toBe("http://x/y");
    expect(seen!.init.method).toBe("POST");
    expect((seen!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(seen!.init.body).toBe('{"a":1}');
  });

  test("throws BrainError with status on non-2xx", async () => {
    const fakeFetch = async () => new Response("boom", { status: 500 });
    await expect(postJson("http://x", {}, { fetch: fakeFetch, timeoutMs: 1000 })).rejects.toBeInstanceOf(BrainError);
    try {
      await postJson("http://x", {}, { fetch: fakeFetch, timeoutMs: 1000 });
    } catch (e) {
      expect((e as BrainError).status).toBe(500);
      expect((e as BrainError).message).toContain("boom");
    }
  });

  test("aborts on timeout", async () => {
    const fakeFetch = (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
    const t0 = performance.now();
    await expect(postJson("http://x", {}, { fetch: fakeFetch, timeoutMs: 50 })).rejects.toThrow(/aborted|timeout/);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("honours an external abort signal", async () => {
    const fakeFetch = (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
    const ctl = new AbortController();
    const p = postJson("http://x", {}, { fetch: fakeFetch, timeoutMs: 10_000, signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });

  test("wraps network errors as BrainError", async () => {
    const fakeFetch = async () => {
      throw new TypeError("connection refused");
    };
    await expect(postJson("http://x", {}, { fetch: fakeFetch, timeoutMs: 1000 })).rejects.toThrow(/connection refused/);
  });
});
