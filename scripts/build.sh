#!/usr/bin/env bash
# Build the single binary with the Bun this repo pins. A binary built by another
# Bun carries that Bun's runtime, whatever the lockfile says.
set -euo pipefail
cd "$(dirname "$0")/.."
want=$(tr -d '[:space:]' < .bun-version)
have=$(bun --version)
if [[ $have != "$want" ]]; then
  echo "build: bun $have found, .bun-version pins $want; run: bun upgrade --version $want" >&2
  exit 1
fi
exec bun build --compile --minify src/main.ts --outfile dist/agentciv
