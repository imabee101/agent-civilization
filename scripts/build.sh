#!/usr/bin/env bash
# Build the single binary with the Bun this repo pins. A binary built by another
# Bun carries that Bun's runtime, whatever the lockfile says.
set -euo pipefail
cd "$(dirname "$0")/.."
want=$(tr -d '[:space:]' < .bun-version)
have=$(bun --version)
if [[ $have != "$want" ]]; then
  echo "build: bun $have found, .bun-version pins $want; install bun $want (bun upgrade takes the latest stable; curl -fsSL https://bun.sh/install | bash -s bun-v$want for an exact one)" >&2
  exit 1
fi
exec bun build --compile --minify src/main.ts --outfile dist/agentciv
