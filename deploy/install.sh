#!/usr/bin/env bash
# Install or update the deployment on this box. Run as root from the repo root
# after `bun run build`. Idempotent; see deploy/README.md.
#
#   sudo deploy/install.sh [--brain local|grok] [--grok-user U] [--grok-model M] [--fresh]
#
# Everything about the box comes from /etc/agent-civ/install.env (untracked):
#   HOST, PORT, DOMAIN, VAULT_ADDR, and optionally LLAMA_DIR, MODEL, MODEL_ALIAS,
#   GAME_FLAGS, SLOTS, CTX_PER_SLOT, BRAIN, GROK_USER, GROK_MODEL. Flags win.
#   Nothing here names a machine.
# --brain local: llama-server on this box (needs LLAMA_DIR and MODEL). --brain grok: the
#   Grok sign-in of GROK_USER (default: whoever ran sudo); the local brain is still installed
#   and kept running when LLAMA_DIR and MODEL are set, so switching back is one flag.
# --fresh: the current world, history and backups move to /var/lib/agent-civ-archive/<time>
#   and the game starts a new world.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTALL_ENV=${INSTALL_ENV:-/etc/agent-civ/install.env}
[[ -f $INSTALL_ENV ]] || { echo "install: $INSTALL_ENV missing; see deploy/README.md for its variables" >&2; exit 1; }
. "$INSTALL_ENV"
FRESH=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --brain) BRAIN=$2; shift 2 ;;
    --grok-user) GROK_USER=$2; shift 2 ;;
    --grok-model) GROK_MODEL=$2; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    *) echo "install: unknown argument $1 (--brain local|grok, --grok-user, --grok-model, --fresh)" >&2; exit 1 ;;
  esac
done
for v in HOST DOMAIN VAULT_ADDR; do
  [[ -n ${!v:-} ]] || { echo "install: $v not set in $INSTALL_ENV" >&2; exit 1; }
done
PORT=${PORT:-443}
GAME_FLAGS=${GAME_FLAGS:-"--max-agents 12 --concurrency 3 --max-tokens 600"}
BRAIN=${BRAIN:-local}
LOCAL=0
[[ -n ${LLAMA_DIR:-} && -n ${MODEL:-} ]] && LOCAL=1
case $BRAIN in
  local)
    [[ $LOCAL == 1 ]] || { echo "install: --brain local needs LLAMA_DIR and MODEL in $INSTALL_ENV" >&2; exit 1; } ;;
  grok)
    GROK_USER=${GROK_USER:-${SUDO_USER:-}}
    [[ -n $GROK_USER && $GROK_USER != root ]] || { echo "install: --brain grok needs --grok-user (or GROK_USER), the user who ran \`grok login\`" >&2; exit 1; }
    GROK_HOME=$(getent passwd "$GROK_USER" | cut -d: -f6)
    [[ -f $GROK_HOME/.grok/auth.json ]] || { echo "install: $GROK_USER has no Grok sign-in; run \`grok login\` as $GROK_USER" >&2; exit 1; }
    BRAIN_FLAGS="--brain grok --grok-auth-file /run/agent-civ-grok/auth.json${GROK_MODEL:+ --model $GROK_MODEL}" ;;
  *) echo "install: --brain must be local or grok, not $BRAIN" >&2; exit 1 ;;
esac
if [[ $LOCAL == 1 ]]; then
  MODEL_ALIAS=${MODEL_ALIAS:-$(basename "$MODEL" .gguf | tr '[:upper:]' '[:lower:]')}
  [[ $BRAIN == local ]] && BRAIN_FLAGS="--brain openai --base-url http://127.0.0.1:8080/v1 --model $MODEL_ALIAS"
fi

[[ $EUID -eq 0 ]] || { echo "install: run as root" >&2; exit 1; }
[[ -x dist/agentciv ]] || { echo "install: dist/agentciv missing; run bun run build" >&2; exit 1; }
[[ -f /etc/agent-civ/approle.env ]] || { echo "install: /etc/agent-civ/approle.env missing; see deploy/README.md" >&2; exit 1; }

# Both services map their binaries; replacing a mapped file under a running
# process ends it with SIGBUS. Stop first, copy beside, move into place.
systemctl stop agent-civ.service agent-civ-llm.service 2>/dev/null || true
install -d -m 0755 /opt/agent-civ
install -m 0755 dist/agentciv /opt/agent-civ/agentciv.new && mv -f /opt/agent-civ/agentciv.new /opt/agent-civ/agentciv
install -m 0755 deploy/renew-tls.sh deploy/grok-token.sh /opt/agent-civ/
install -m 0644 deploy/agentciv.slice deploy/agent-civ{,-llm,-renew,-grok-token}.service deploy/agent-civ-{renew,grok-token}.timer /etc/systemd/system/
# The game joins this group to read the borrowed Grok token; it owns nothing else.
groupadd -rf agentciv-grok
install -d -m 0755 /etc/agent-civ /etc/systemd/system/agent-civ.service.d
# The game needs the local brain running only when it thinks with it.
if [[ $BRAIN == local ]]; then
  printf '[Unit]\nWants=agent-civ-llm.service\n' > /etc/systemd/system/agent-civ.service.d/brain.conf
else
  rm -f /etc/systemd/system/agent-civ.service.d/brain.conf
fi
if [[ $BRAIN == grok ]]; then
  install -d -m 0755 /etc/systemd/system/agent-civ-grok-token.service.d
  printf '[Service]\nUser=%s\n' "$GROK_USER" > /etc/systemd/system/agent-civ-grok-token.service.d/user.conf
fi

if [[ $LOCAL == 1 ]]; then
  install -d -m 0755 /opt/agent-civ/models /opt/agent-civ/llama.cpp
  cp -a --remove-destination "$LLAMA_DIR/bin" "$LLAMA_DIR/lib" /opt/agent-civ/llama.cpp/
  install -m 0644 "$MODEL" /opt/agent-civ/models/
  # The brain's flags come from what this box has, not from a file someone edits.
  # A GPU with room for the model takes every layer; otherwise the CPU's
  # performance cores decode and every core prefills. Slots: one per node.
  SLOTS=${SLOTS:-12}
  CTX_PER_SLOT=${CTX_PER_SLOT:-6144}
  MODEL_FILE=/opt/agent-civ/models/$(basename "$MODEL")
  devices=$(/opt/agent-civ/llama.cpp/bin/llama-server --list-devices 2>/dev/null | grep -E '^\s+\S+: .*MiB' || true)
  if [[ -n $devices ]]; then
    compute="gpu ($(printf '%s\n' "$devices" | head -1 | sed -E 's/^\s+//'))"
    LLAMA_FLAGS="-ngl 99 -fa on"
  else
    # Performance cores run near the top clock (a couple of favoured cores boost 100 MHz above the rest)
    # and show two threads per core; count the cores, not the threads. Within 5% of the top counts.
    top=$(lscpu -e=MAXMHZ | tail -n +2 | sort -n | tail -1)
    pcores=$(lscpu -e=CORE,MAXMHZ | tail -n +2 | awk -v top="$top" '$2 >= top * 0.95 {print $1}' | sort -u | wc -l)
    cores=$(lscpu -e=CORE | tail -n +2 | sort -u | wc -l)
    [[ $pcores -gt 0 ]] || pcores=$cores
    compute="cpu ($pcores performance cores of $cores)"
    # q8 KV halves the cache; flash attention is what allows the quantised V cache on CPU.
    LLAMA_FLAGS="-t $pcores -tb $cores -fa on -ctk q8_0 -ctv q8_0"
  fi
  LLAMA_FLAGS="-m $MODEL_FILE --alias $MODEL_ALIAS -c $((SLOTS * CTX_PER_SLOT)) -np $SLOTS $LLAMA_FLAGS"
  printf 'LLAMA_FLAGS=%s\n' "$LLAMA_FLAGS" > /etc/agent-civ/llm.env
  echo "install: local brain on $compute: $LLAMA_FLAGS"
fi
printf 'HOST=%s\nPORT=%s\nBRAIN_FLAGS=%s\nGAME_FLAGS=%s\n' "$HOST" "$PORT" "$BRAIN_FLAGS" "$GAME_FLAGS" > /etc/agent-civ/game.env
# The operator token: made once, root-only, never printed here. Read it with:
#   sudo cat /etc/agent-civ/operator-token
if [[ ! -s /etc/agent-civ/operator-token ]]; then
  (umask 077; openssl rand -hex 16 > /etc/agent-civ/operator-token)
  echo "install: operator token created at /etc/agent-civ/operator-token (sudo cat it to hold the switch)"
fi
echo "install: game thinks with $BRAIN: $BRAIN_FLAGS"
echo "install: game on https://$DOMAIN ($HOST:$PORT): $GAME_FLAGS"
systemctl daemon-reload

# DynamicUser keeps the state under /var/lib/private; the archive is root's alone.
if [[ $FRESH == 1 && -d /var/lib/private/agent-civ ]] && [[ -n $(ls -A /var/lib/private/agent-civ) ]]; then
  archive=/var/lib/agent-civ-archive/$(date +%Y%m%d-%H%M%S)
  install -d -m 0700 "$archive"
  mv /var/lib/private/agent-civ/* "$archive"/
  echo "install: previous world, history and backups moved to $archive; starting a new world"
fi

/opt/agent-civ/renew-tls.sh
systemctl enable --now agent-civ-renew.timer
systemctl enable agent-civ.service
if [[ $LOCAL == 1 ]]; then
  systemctl enable --now agent-civ-llm.service
else
  systemctl disable --now agent-civ-llm.service 2>/dev/null || true
fi
if [[ $BRAIN == grok ]]; then
  # The token must exist before the game's first turn; a failed renewal stops the install here.
  systemctl start agent-civ-grok-token.service
  systemctl enable --now agent-civ-grok-token.timer
else
  systemctl disable --now agent-civ-grok-token.timer 2>/dev/null || true
fi
systemctl start agent-civ.service
