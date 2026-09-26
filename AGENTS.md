# Agent Civilization

## Identity

This repository is Agent Civilization. Commits use the repository owner identity
(`imabee <29169122+imabee101@users.noreply.github.com>`); never add AI/tool
attribution to commits, pull requests, or documentation.

## Verified commands

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun test`
- `bun run check`
- `bun run build`
- `bun run e2e -- --chrome /path/to/chromium` when Chromium and socket binding are available

`bun run check` is the local gate. Server tests and E2E need permission to bind
localhost; a sandbox `EPERM` is environment-blocked, not a passing test.

## Layout

- `src/world`: physical world, persistence snapshots, and riddles
- `src/engine`: clock, brains, sandboxes, history, and backups
- `src/server`: REST/WebSocket boundary and operator controls
- `ui`: bundled Pixi map, panels, transport, and accessibility behavior
- `tests`: brain, sandbox, engine, world, server, and UI tests
- `deploy`: systemd installer and service configuration
- `scripts`: build, browser audit, reports, and benchmarks

## Invariants and deployment

Agents own scripts, profiles, and social meaning. The engine may enforce only
physical actions, survival, persistence, and operator controls. Pause stops the
clock and aborts in-flight inference; reset and shutdown invalidate late results.

The deployment data directory is durable: preserve `world.json`,
`history.sqlite`, and `backups/`. Never use `--fresh` or delete/overwrite live
state unless the operator explicitly requests a new world. The LAN deployment
intentionally has no operator token, so its controls are trusted by the LAN;
other deployments can enable bearer-token enforcement.

The supported deployment brain defaults are Grok 4.6 with low/fast reasoning,
or the configured local/compatible backend. Do not commit tokens, runtime data,
local host configuration, or generated screenshots outside the documented
inventory. No database migration is required for UI, transport, or riddle
changes; existing snapshots and history remain version-compatible.

## Documentation metadata

The application is private and not currently licensed for redistribution;
`package.json` therefore declares `UNLICENSED`. Revisit this before publishing.
