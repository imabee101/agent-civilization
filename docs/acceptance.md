# Acceptance: measured against plan.md and the verbal brief

Each row names the requirement, where it lives, and the evidence. "Test"
means an automated test in `tests/`; run `bun test` to re-verify.

## plan.md — the core idea and the failure mode to avoid

| Requirement | Where | Evidence |
| --- | --- | --- |
| Shared world, many small local models, one node each | `src/engine/engine.ts`, `src/brain/*` | Engine keeps one sandbox per living node; any OpenAI-compatible / llama.cpp / Ollama server drives them. |
| No fixed `Action` enum of social moves | `src/sandbox/api.ts` | The API is physical only: move, gather, eat, drop, rest, build, demolish, plant, take, say, send, files, boards, cache. |
| No engine faction / relationship / reputation structures | `src/world/world.ts`, `src/shared/protocol.ts` | Test `tests/integration/world-run.test.ts` greps engine sources for social vocabulary and fails on any hit. |
| No automatic detection→consequence pipeline | `src/world/world.ts` `resolveIntent` | Messages are delivered as bytes; test "the engine never interprets message content". |
| No narrator, no engine-authored speech | `src/world/world.ts` `emit` | Event text is factual ("X moved ne to 3,-1"); quotes are verbatim agent output only. UI narration speaks only literal text (`ui/lib/narration.ts`, tested). |
| No heuristic "interesting" brain | `src/brain/random.ts` | Uniform over snippets, no weights; test asserts every option appears at equal rates. |
| Agents own a private filesystem and a rewritable script | `src/world/world.ts` fs*, `src/engine/engine.ts` `loadScriptIfChanged` | Tests: quota, paths, main.js reload after change, handlers reinstalled after restore. |
| Model replies with real code that runs immediately | `src/engine/engine.ts` `runTurn`, `src/brain/prompt.ts` | Test "a turn sends the prompt, runs the returned code…". |
| Persistent handlers `onTick` / `onMessage` (+ `onHear`) | `src/sandbox/sandbox.ts` `callHandler` | Tests in `tests/sandbox` and `tests/engine`. |
| Only tiny primitives between agents; meaning decided by receiver | `src/engine/engine.ts` `deliver` | Test "a node that obeys strangers gets rewritten" (naive `eval` node vs. careful farmer). |
| Survival is the only forcing function; ruins keep files | `src/world/world.ts` `survival` | Tests: starvation → death → ruin with files intact; ruin files readable only when adjacent. |
| Outer sandbox airtight with adversarial tests | `src/sandbox/sandbox.ts`, `tests/sandbox/sandbox.test.ts` | Exact global allowlist; loops, recursion, single/aggregate memory bombs, host-call floods, prototype pollution, hostile eval; no process-memory leak across rebuilt nodes. |
| Inner boundary deliberately not engine-secured | `src/engine/engine.ts` | Test "the inner boundary is the agent's own problem". |
| QuickJS WASM, one runtime per node, limits set | `src/sandbox/sandbox.ts` | One WASM module instance per node; memory / stack / deadline limits. |

## plan.md — stack and standing requirements

| Requirement | Where | Evidence |
| --- | --- | --- |
| Bun + TypeScript end to end | whole repo | `bun test`, `bun run typecheck`; Bun 1.4.2 pinned in `.bun-version`. |
| Single self-contained binary | `package.json` `build` | `bun build --compile` embeds server, engine, QuickJS WASM (single-file variant) and the bundled UI. Verified boot, page, assets, WS, snapshot on SIGTERM, restore. |
| Any OpenAI-compatible endpoint + llama.cpp + Ollama + random fallback | `src/brain/*` | Tests against fake fetch: request shape, SSE / NDJSON streaming across chunk boundaries, timeouts, health, autodetect order, custom `registerBrain`. |
| Frontend look/feel per UI spec | `ui/` | See the UI section below and the screenshots in `scratch/ui-shots/`. |
| Long-term persistence (days–months) | `src/engine/engine.ts` snapshots, `src/engine/history.ts`, `src/engine/backups.ts` | Snapshot every N ticks + on signal; SQLite history of all events/decisions; hourly rotated backups via `Bun.cron`. Tests for each. |
| Full nerd-mode transparency | `ui/` "under the hood", `/api/decisions`, `/api/agents/:id/files` | Raw prompts/outputs, live files, logs, pacing. |
| Adaptive pacing from measured latency | `src/engine/pacing.ts` | Tests: realtime vs queued, interval stretches with latency / nodes / speed, shrinks with concurrency. Scheduling only; changes nothing agents may do. |
| Documentation with personality, after the build | `README.md`, `docs/node-api.md` | Written after the system worked. |
| Grandiose-small-model humour only as literal agent output | `README.md` "A note on tone", ruins in `src/world/features.ts` | Ruins are data; the engine never speaks. |
| Acceptance test in plan.md | `tests/integration/world-run.test.ts` | Automated grep for social-outcome code in engine sources. |

## Verbal brief

| Instruction | Where | Evidence |
| --- | --- | --- |
| Colony / civilization of agents, undirected, made easy | `src/world/world.ts` `intentReplicate`, seasons | `replicate()` copies files+profile to an adjacent child with its own mind (cap 64); seasons make stored food matter; Cache holds 4 KB entries so scripts spread. Nothing prescribes a shape. Tests in `tests/world/civilization.test.ts`. |
| Install Bun the correct way | `.claude/hooks/ensure-bun.sh`, README | Official installer when reachable, else Bun's official npm package; `bun --version` = 1.4.2 system-wide. |
| Rename to agent-civilization | `package.json`, CLI `agentciv`, `AGENTCIV_*` env, README, UI title/wordmark | Done; update the git remote after renaming the GitHub repo (old URL redirects). |

### Earlier instructions

| Instruction | Where | Evidence |
| --- | --- | --- |
| Allow llama.cpp or any backend | `src/brain/llamacpp.ts`, `registry.ts` | Native `/completion` backend with prompt templates; `openai` covers `/v1`; `registerBrain` for anything else. |
| Never commit as Claude; no attribution; keep the settings in the repo | `.claude/settings.json`, `.claude/hooks/git-identity.sh`, `CLAUDE.md` | Every commit authored `imabee <29169122+imabee101@users.noreply.github.com>`; hook re-applies on session start. |
| Use the latest Bun's benefits | `.bun-version`, `src/server/app.ts`, `src/engine/history.ts`, `src/engine/backups.ts`, `scripts/e2e-screens.ts` | Bun 1.4.2: WebSocket pub/sub fan-out, `bun:sqlite` history, `Bun.cron` backups, `bun run --parallel` check, DevTools-protocol screenshots from plain Bun. |
| Encourage communication / collectives / factions / rivalry without gating or choosing | `src/world/features.ts`, `src/world/world.ts` | Nuggets only: Cache, plaque, boards, springs, towers, vault + key, hidden items, materials + building, ancient ruins with protocols. No verb is social; everything is physical; anyone can do anything to anything. |
| A message board for them to grab onto | `src/world/world.ts` boards + cache | `board.read/post`, and the Cache where directory names are the message. |
| Comprehensive, realistic sandbox with tools, not overboard | `src/sandbox/api.ts` | ~30 primitives across body, ground, communication, files, helpers; every one has one physical effect. |
| Hidden artifacts placed strategically | `src/world/world.ts` `placeFeatures` | Key on sand/grass, lantern on rock/sand, seeds in forests, spare relay on grass; revealed only by standing there; the Cartographer's map names them vaguely. |
| Meme inspiration, clean | `src/world/features.ts` | Shared cache as message board, "counting ourselves", a plaque for an eval nobody runs, a Grader that says PASS, "graded: gone". No real names. |
| Works on any device, portrait and landscape, no empty space, no overflow | `ui/app.css`, `scripts/e2e-screens.ts` | See UI section. |
| Test and run it; screenshots | `bun test` (267 tests, 23 files), `bun run e2e` | `docs/screenshots/*.png`; full set in `scratch/ui-shots/` with `report.json`. Compiled binary `dist/agentciv` verified: page, assets, API, WebSocket, history, snapshot on SIGTERM, restore. |

## UI

Filled in from the end-to-end run; see below.

Automated audit (`bun run e2e`, Chromium over the DevTools protocol, real server on the random brain): **57/57 checks passed**.

Each check asserts: the page does not scroll, the canvas covers the full viewport, no visible element extends outside the viewport (clip-aware), `html/body` overflow hidden, the map covers >= 98.5% of the viewport (`coverage()`), and on mobile every opened panel fills the free area between the top bar and the tab bar.

| Viewport | States checked | Result | Map coverage |
| --- | --- | --- | --- |
| desktop-1440x900 | world, dossier-agent, dossier-tile, hood-brain, hood-nodes, hood-pacing, back-to-world | all pass | 1.000 |
| laptop-1280x720 | world, dossier-agent, dossier-tile, hood-brain, hood-nodes, hood-pacing, back-to-world | all pass | 1.000 |
| tablet-landscape-1024x768 | world, dossier-agent, dossier-tile, hood-brain, hood-nodes, hood-pacing, back-to-world | all pass | 1.000 |
| tablet-portrait-768x1024 | world, dossier-agent, dossier-tile, groups, chronicle, hood-brain, hood-nodes, hood-pacing, back-to-world | all pass | 1.000 |
| phone-portrait-390x844 | world, dossier-agent, dossier-tile, groups, chronicle, hood-brain, hood-nodes, hood-pacing, back-to-world | all pass | 1.000 |
| phone-landscape-844x390 | world, dossier-agent, dossier-tile, groups, chronicle, hood-brain, hood-nodes, hood-pacing, back-to-world | all pass | 1.000 |
| small-phone-360x740 | world, dossier-agent, dossier-tile, groups, chronicle, hood-brain, hood-nodes, hood-pacing, back-to-world | all pass | 1.000 |

Representative screenshots are committed under `docs/screenshots/`; the full set (57 PNGs + `report.json`) is written to `scratch/ui-shots/` by the script.

| Requirement (plan.md UI spec / verbal) | Evidence |
| --- | --- |
| Full-bleed hex map behind frosted-glass panels, tokens and type per spec | `ui/app.css` `:root` tokens verbatim; `docs/screenshots/desktop-1440x900-world.png` |
| Map fills the entire viewport in portrait and landscape, never letterboxed, no empty space | Cover fit + clamped pan/zoom + ghost-hex backdrop (`ui/lib/camera.ts` `coverCamera`/`clampCamera`/`coverage`, tested); coverage 1.000 at every viewport |
| No horizontal/vertical scroll, no overflow anywhere | Audit rows above; overflow guard in `ui/overflow-guard.ts` |
| Top bar degrades gracefully; mobile tab bar; rails become full overlays; dossier bottom sheet; nerd drawer full width | `docs/screenshots/phone-*`, `small-phone-*`, `tablet-*` |
| Chronicle shows literal events and literal quotes only; categories derived from generic kinds | `ui/lib/events.ts` (typed over every `EventKind`), `ui/lib/narration.ts`, tests in `tests/ui/` |
| Group cards from agents' self-declared `profile.group` only | `ui/lib/groups.ts`, tested |
| Under-the-hood: raw prompts/outputs, live files/logs, pacing tiles, world structure list | `docs/screenshots/tablet-portrait-768x1024-hood-brain.png`, `laptop-1280x720-hood-nodes.png` |
| Structures, items, the Cache directory listing, boards, lineage, seasons visible | `docs/screenshots/desktop-1440x900-dossier-tile.png` |
| No social vocabulary hardcoded in UI categories/classes/copy | `tests/ui/events.test.ts` forbidden-word guard |
| Optional browser TTS narration of literal text only | `ui/lib/narration.ts` |
