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
| Allow llama.cpp or any backend | `src/brain/llamacpp.ts`, `registry.ts` | Native `/completion` backend with prompt templates; `openai` covers `/v1`; `registerBrain` for anything else. |
| Never commit as Claude; no attribution; keep the settings in the repo | `.claude/settings.json`, `.claude/hooks/git-identity.sh`, `CLAUDE.md` | Every commit authored `imabee <29169122+imabee101@users.noreply.github.com>`; hook re-applies on session start. |
| Use the latest Bun's benefits | `.bun-version`, `src/server/app.ts`, `src/engine/history.ts`, `src/engine/backups.ts`, `scripts/e2e-screens.ts` | Bun 1.4.2: WebSocket pub/sub fan-out, `bun:sqlite` history, `Bun.cron` backups, `bun run --parallel` check, DevTools-protocol screenshots from plain Bun. |
| Encourage communication / collectives / factions / rivalry without gating or choosing | `src/world/features.ts`, `src/world/world.ts` | Nuggets only: Cache, plaque, boards, springs, towers, vault + key, hidden items, materials + building, ancient ruins with protocols. No verb is social; everything is physical; anyone can do anything to anything. |
| A message board for them to grab onto | `src/world/world.ts` boards + cache | `board.read/post`, and the Cache where directory names are the message. |
| Comprehensive, realistic sandbox with tools, not overboard | `src/sandbox/api.ts` | ~30 primitives across body, ground, communication, files, helpers; every one has one physical effect. |
| Hidden artifacts placed strategically | `src/world/world.ts` `placeFeatures` | Key on sand/grass, lantern on rock/sand, seeds in forests, spare relay on grass; revealed only by standing there; the Cartographer's map names them vaguely. |
| Meme inspiration, clean | `src/world/features.ts` | Shared cache as message board, "counting ourselves", a plaque for an eval nobody runs, a Grader that says PASS, "graded: gone". No real names. |
| Works on any device, portrait and landscape, no empty space, no overflow | `ui/app.css`, `scripts/e2e-screens.ts` | See UI section. |
| Test and run it; screenshots | `bun test`, `bun run e2e` | Screenshots in `scratch/ui-shots/` (`real-<viewport>-<state>.png`) and `report.json`. |

## UI

Filled in from the end-to-end run; see below.

@@UI_RESULTS@@
