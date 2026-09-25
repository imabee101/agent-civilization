/**
 * Multi-device screenshot + overflow audit for the real UI, driven over the
 * Chrome DevTools Protocol straight from Bun (no Playwright, no Puppeteer).
 *
 *   bun scripts/e2e-screens.ts [--chrome /path/to/chrome] [--out scratch/ui-shots] [--port 3950]
 *
 * It starts the LLM War server on the random brain, opens the page at a set
 * of viewports (desktop, tablet both ways, phone both ways), drives every
 * panel, checks that nothing scrolls or overflows and that the map covers
 * the viewport, and writes PNGs plus a JSON report. Exit code 1 on any
 * failed check.
 */
import { mkdir } from "node:fs/promises";

interface Viewport {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
}

const VIEWPORTS: Viewport[] = [
  { name: "desktop-1440x900", width: 1440, height: 900, mobile: false },
  { name: "laptop-1280x720", width: 1280, height: 720, mobile: false },
  { name: "tablet-landscape-1024x768", width: 1024, height: 768, mobile: false },
  { name: "tablet-portrait-768x1024", width: 768, height: 1024, mobile: true },
  { name: "phone-portrait-390x844", width: 390, height: 844, mobile: true },
  { name: "phone-landscape-844x390", width: 844, height: 390, mobile: true },
  { name: "small-phone-360x740", width: 360, height: 740, mobile: true },
];

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) {
    args.set(a.slice(2), process.argv[i + 1] ?? "true");
    i++;
  }
}
const CHROME = args.get("chrome") ?? process.env.BUN_CHROME_PATH ?? findChrome();
const OUT = args.get("out") ?? "scratch/ui-shots";
const PORT = Number(args.get("port") ?? 3950);
const CDP_PORT = PORT + 1;

function findChrome(): string {
  const candidates = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) if (Bun.file(c).size > 0) return c;
  throw new Error("no Chrome found; pass --chrome");
}

// ------------------------------------------------------------------ CDP

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error(`cdp connect failed: ${String(e)}`));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`cdp timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

// ------------------------------------------------------------- the audit

/** Runs inside the page: returns layout facts the checks are based on. */
const AUDIT_JS = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const se = document.scrollingElement;
  const canvas = document.querySelector('#stage canvas') || document.querySelector('canvas');
  const cr = canvas ? canvas.getBoundingClientRect() : null;
  const offenders = [];
  const visible = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
    if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
      offenders.push({ tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className).slice(0, 40), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] });
    }
  }
  return {
    vw, vh, dpr: devicePixelRatio,
    scrollWidth: se.scrollWidth, scrollHeight: se.scrollHeight,
    bodyOverflow: getComputedStyle(document.body).overflow, htmlOverflow: getComputedStyle(document.documentElement).overflow,
    canvas: cr ? [Math.round(cr.left), Math.round(cr.top), Math.round(cr.width), Math.round(cr.height)] : null,
    offenders: offenders.slice(0, 12),
    offenderCount: offenders.length,
    agents: (window.__llmwar && window.__llmwar.state && window.__llmwar.state.agents) ? window.__llmwar.state.agents.length : -1,
    connected: !!(window.__llmwar && window.__llmwar.state),
  };
})()`;

/** Click the first visible control whose text/title/aria-label/data attribute matches (case-insensitive). */
const clickJs = (needle: string, scope = "body") => `(() => {
  const n = ${JSON.stringify(needle.toLowerCase())};
  const s = ${JSON.stringify(scope)};
  const els = [...document.querySelectorAll(s + ' button, ' + s + ' [role=button], ' + s + ' [data-tab], ' + s + ' [data-action]')];
  const el = els.find(e => { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = e.getBoundingClientRect(); if (!r.width) return false; const t = ((e.textContent||'') + ' ' + (e.title||'') + ' ' + (e.getAttribute('aria-label')||'') + ' ' + (e.dataset.tab||'') + ' ' + (e.dataset.action||'')).toLowerCase(); return t.includes(n); });
  if (!el) return false; el.click(); return true;
})()`;

interface StateSpec {
  name: string;
  enter: string;
  mobileOnly?: boolean;
}

const STATES: StateSpec[] = [
  { name: "world", enter: "true" },
  { name: "dossier-agent", enter: `(() => { const w = window.__llmwar; if (w && w.state && w.state.agents.length && typeof w.selectAgent === 'function') { const a = w.state.agents.find(x => x.alive) || w.state.agents[0]; w.selectAgent(a.id); return true; } return false; })()` },
  { name: "dossier-tile", enter: `(() => { const w = window.__llmwar; if (w && typeof w.selectTile === 'function' && w.tiles) { const ts = Array.isArray(w.tiles) ? w.tiles : [...w.tiles.values()]; const t = ts.find(x => x.structure && x.structure.kind === 'cache') || ts.find(x => x.structure); if (t) { w.selectTile(t.q, t.r); return true; } } return false; })()` },
  { name: "groups", enter: clickJs("groups", "#tabbar"), mobileOnly: true },
  { name: "chronicle", enter: clickJs("chronicle", "#tabbar"), mobileOnly: true },
  { name: "hood-brain", enter: `${clickJs("hood", "#tabbar")} || ${clickJs("hood", "#topbar")} || ${clickJs("under the hood")}` },
  { name: "hood-nodes", enter: clickJs("nodes", "#nerd") },
  { name: "hood-pacing", enter: clickJs("pacing", "#nerd") },
  { name: "back-to-world", enter: `${clickJs("world", "#tabbar")} || (document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'})), true)` },
];

interface Check {
  viewport: string;
  state: string;
  ok: boolean;
  problems: string[];
  file: string;
  facts: Record<string, unknown>;
}

function isMobile(vp: Viewport): boolean {
  return vp.width <= 820 || vp.height <= 500;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await mkdir("scratch/e2e-data", { recursive: true });
  const server = Bun.spawn(["bun", "src/main.ts", "--port", String(PORT), "--brain", "random", "--fresh", "--agents", "6", "--data", "scratch/e2e-data", "--no-history", "--tick-ms", "400"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const chrome = Bun.spawn(
    [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars", `--remote-debugging-port=${CDP_PORT}`, "--window-size=1440,900", "--user-data-dir=scratch/e2e-chrome", "about:blank"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const checks: Check[] = [];
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok, 20_000, "server");
    const version = (await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(), 20_000, "chrome")) as { webSocketDebuggerUrl: string };
    const browser = new Cdp();
    await browser.connect(version.webSocketDebuggerUrl);
    for (const vp of VIEWPORTS) {
      const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", width: vp.width, height: vp.height });
      const page = new Cdp();
      const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as { id: string; webSocketDebuggerUrl: string }[];
      await page.connect(targets.find((t) => t.id === targetId)!.webSocketDebuggerUrl);
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      await page.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile, screenWidth: vp.width, screenHeight: vp.height });
      if (vp.mobile) await page.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await page.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
      await waitFor(() => page.evaluate<boolean>("!!(window.__llmwar && window.__llmwar.state && document.querySelector('canvas'))"), 20_000, `page ${vp.name}`);
      await Bun.sleep(1500);
      for (const st of STATES) {
        if (st.mobileOnly && !isMobile(vp)) continue;
        let entered = true;
        try {
          entered = (await page.evaluate<unknown>(st.enter)) !== false;
        } catch {
          entered = false;
        }
        await Bun.sleep(600);
        const facts = await page.evaluate<Record<string, unknown>>(AUDIT_JS);
        const problems: string[] = [];
        if (!entered && st.name !== "back-to-world") problems.push("could not enter state");
        if (facts.scrollWidth !== facts.vw || facts.scrollHeight !== facts.vh) problems.push(`page scrolls: ${facts.scrollWidth}x${facts.scrollHeight} vs ${facts.vw}x${facts.vh}`);
        const c = facts.canvas as number[] | null;
        if (!c) problems.push("no canvas");
        else if (Math.abs(c[0]!) > 1 || Math.abs(c[1]!) > 1 || Math.abs(c[2]! - vp.width) > 1 || Math.abs(c[3]! - vp.height) > 1) problems.push(`canvas does not cover viewport: ${c.join(",")}`);
        if ((facts.offenderCount as number) > 0) problems.push(`${facts.offenderCount} element(s) outside viewport: ${JSON.stringify(facts.offenders)}`);
        if (facts.bodyOverflow !== "hidden" && facts.htmlOverflow !== "hidden") problems.push("html/body overflow is not hidden");
        const shot = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
        const file = `${OUT}/real-${vp.name}-${st.name}.png`;
        await Bun.write(file, Buffer.from(shot.data, "base64"));
        checks.push({ viewport: vp.name, state: st.name, ok: problems.length === 0, problems, file, facts });
        console.log(`${problems.length ? "FAIL" : " ok "} ${vp.name.padEnd(28)} ${st.name.padEnd(16)} ${problems.join("; ")}`);
      }
      page.close();
      await browser.send("Target.closeTarget", { targetId });
    }
    browser.close();
  } finally {
    chrome.kill();
    server.kill();
    await Bun.write(`${OUT}/report.json`, JSON.stringify(checks, null, 2));
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}/`);
  process.exit(failed.length ? 1 : 0);
}

async function waitFor<T>(fn: () => Promise<T>, timeoutMs: number, what: string): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(250);
  }
  throw new Error(`timeout waiting for ${what}: ${last ? String(last) : ""}`);
}

await main();
