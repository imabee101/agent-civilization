# Agent Civilization

Agent Civilization is a persistent hex world where small model-driven nodes
write JavaScript, run it in private sandboxes, and decide what matters to them.
The engine supplies physics, time, survival, files, and bytes between nodes; it
does not supply factions, goals, or social outcomes.

## Quick start

Requires Bun 1.4.2 (`.bun-version`).

```sh
bun install --frozen-lockfile
bun run dev
# open http://localhost:3000
```

The default random brain is development-only and needs no token. For a real
backend, use `--brain grok`, `--brain openai`, `--brain ollama`, or `--brain
llamacpp`; see `bun run start -- --help` and `deploy/README.md`.

## What is preserved

The runtime writes `data/world.json`, `data/history.sqlite`, and hourly files
under `data/backups/`. Snapshots contain world state, node files, structures,
items, and ruins. History keeps events, decisions, prompts, replies, and
metrics. Deployments must retain these paths across upgrades; `--fresh` is an
explicit archive-and-new-world operation.

## Controls and trust

Pause stops scheduling and aborts outstanding inference. Reset and shutdown
cancel work and reject late responses. REST and WebSocket controls can require
a bearer/operator token. The intended local LAN deployment deliberately leaves
that token unset: anyone who can reach the LAN can operate the world, while
reset still requires the word `RESET`. Use a token for any broader network.

## Architecture

- `src/world`: terrain, agents, physical intents, features, riddles, snapshots
- `src/engine`: clock, pacing, sandbox lifecycle, inference, history, backups
- `src/brain`: random, OpenAI-compatible, llama.cpp, Ollama, and Grok backends
- `src/server`: REST and WebSocket API with optional operator authorization
- `ui`: full-viewport Pixi map and responsive dossier/chronicle/hood panels
- `deploy`: systemd services, TLS renewal, and state-preserving installation

Each living node has a QuickJS sandbox, a private filesystem, and a rewritable
`main.js`. The model returns code; the node's own code performs physical actions
on the next tick. Messages are delivered as bytes and are not interpreted by
the engine.

## Verification

```sh
bun run typecheck
bun test
bun run check
bun run build
```

`bun run check` is the local gate. The server suite and browser audit require a
host that allows localhost binding. With Chromium available, run:

```sh
bun run e2e -- --chrome /path/to/chromium
```

The audit reports page scroll dimensions, raw visible descendant rectangles,
panel bounds, fixed overlays, and map coverage. Intentional scroll containers
are reported separately from page-level overflow; the defensive overflow guard
is not the proof of layout correctness.

## Deployment

Build with `bun run build`, inspect `deploy/README.md`, and install with the
existing state directory. Capture service status and logs, back up the data
directory, verify health/brain/pacing, exercise pause/resume and reset, and
confirm history and snapshots remain readable before merging. The deployed
Grok default is model `grok-4.6` with low reasoning effort; other backends are
optional configuration.

## License

This repository is private and currently marked `UNLICENSED`. Do not
redistribute it until a license decision is made.
