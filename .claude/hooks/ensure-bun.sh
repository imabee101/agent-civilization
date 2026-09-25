#!/bin/sh
# Make sure a Bun that matches .bun-version (major.minor) is on PATH. Uses Bun's
# official install script when reachable, otherwise Bun's official npm package.
want="$(cat "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.bun-version" 2>/dev/null || echo 1.4.2)"
have="$(bun --version 2>/dev/null || echo 0.0.0)"
major_minor() { echo "$1" | cut -d. -f1,2; }
if [ "$(major_minor "$have")" = "$(major_minor "$want")" ]; then exit 0; fi
if curl -fsSL -m 8 https://bun.sh/install -o /tmp/bun-install.sh 2>/dev/null; then
  BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}" bash /tmp/bun-install.sh "bun-v$want" >/dev/null 2>&1 && exit 0
fi
if command -v npm >/dev/null 2>&1; then
  npm install -g "bun@$want" --no-audit --no-fund >/dev/null 2>&1 && exit 0
fi
echo "ensure-bun: could not install Bun $want (have $have)" >&2
exit 0
