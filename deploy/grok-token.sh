#!/usr/bin/env bash
# Runs as the user whose `grok login` the game borrows (agent-civ-grok-token.service).
# Has the CLI renew the sign-in when it has under an hour left, then copies only the
# access token and its expiry where the game can read them. The refresh token stays home.
set -euo pipefail
GROK_BIN=${GROK_BIN:-$HOME/.local/bin/grok}
OUT=${RUNTIME_DIRECTORY:-/run/agent-civ-grok}/auth.json
GROK_AUTH_EARLY_INVALIDATION_SECS=3600 "$GROK_BIN" models >/dev/null
umask 027
python3 - "$HOME/.grok/auth.json" "$OUT" <<'PY'
import json, os, sys
src, out = sys.argv[1], sys.argv[2]
entry = next((v for v in json.load(open(src)).values() if isinstance(v, dict) and v.get("key")), None)
if entry is None:
    sys.exit("grok-token: no sign-in in " + src + "; run `grok login`")
tmp = out + ".new"
with open(tmp, "w") as f:
    json.dump({"grok": {"key": entry["key"], "expires_at": entry.get("expires_at")}}, f)
os.replace(tmp, out)
PY
