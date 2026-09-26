#!/usr/bin/env bash
# Install or update the LAN deployment on this workstation. Run as root from the
# repo root after `bun run build`. Idempotent; see deploy/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

LLAMA=${LLAMA_DIR:-/home/imma/projects/llm/.opt/llama.cpp}
MODEL=${MODEL:-/home/imma/projects/llm/models/Huihui-Qwen3-4B-Instruct-2507-abliterated.i1-Q4_0.gguf}

[[ $EUID -eq 0 ]] || { echo "install: run as root" >&2; exit 1; }
[[ -x dist/agentciv ]] || { echo "install: dist/agentciv missing; run bun run build" >&2; exit 1; }
[[ -f /etc/agent-civ/approle.env ]] || { echo "install: /etc/agent-civ/approle.env missing; see deploy/README.md" >&2; exit 1; }

# Both services map their binaries; replacing a mapped file under a running
# process ends it with SIGBUS. Stop first, copy beside, move into place.
systemctl stop agent-civ.service agent-civ-llm.service 2>/dev/null || true
install -d -m 0755 /opt/agent-civ/models /opt/agent-civ/llama.cpp
install -m 0755 dist/agentciv /opt/agent-civ/agentciv.new && mv -f /opt/agent-civ/agentciv.new /opt/agent-civ/agentciv
install -m 0755 deploy/renew-tls.sh /opt/agent-civ/
cp -a --remove-destination "$LLAMA/bin" "$LLAMA/lib" /opt/agent-civ/llama.cpp/
install -m 0644 "$MODEL" /opt/agent-civ/models/
install -m 0644 deploy/agentciv.slice deploy/agent-civ{,-llm,-renew}.service deploy/agent-civ-renew.timer /etc/systemd/system/

# The brain's flags come from what this box has, not from a file someone edits.
# A GPU with room for the model takes every layer; otherwise the CPU's
# performance cores decode and every core prefills. Slots: 12 nodes, one each.
SLOTS=${SLOTS:-12}
CTX_PER_SLOT=${CTX_PER_SLOT:-6144}
MODEL_FILE=/opt/agent-civ/models/$(basename "$MODEL")
devices=$(/opt/agent-civ/llama.cpp/bin/llama-server --list-devices 2>/dev/null | grep -E '^\s+\S+: .*MiB' || true)
if [[ -n $devices ]]; then
  vram=$(printf '%s\n' "$devices" | grep -oE '[0-9]+ MiB free' | awk '{s+=$1} END {print s+0}')
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
LLAMA_FLAGS="-m $MODEL_FILE --alias $(basename "$MODEL" .gguf | tr '[:upper:]' '[:lower:]' | sed -E 's/^huihui-//; s/-instruct//; s/\.i1-q4_0$//') -c $((SLOTS * CTX_PER_SLOT)) -np $SLOTS $LLAMA_FLAGS"
install -d -m 0755 /etc/agent-civ
printf 'LLAMA_FLAGS=%s\n' "$LLAMA_FLAGS" > /etc/agent-civ/llm.env
# The operator token: made once, root-only, never printed here. Read it with:
#   sudo cat /etc/agent-civ/operator-token
if [[ ! -s /etc/agent-civ/operator-token ]]; then
  (umask 077; openssl rand -hex 16 > /etc/agent-civ/operator-token)
  echo "install: operator token created at /etc/agent-civ/operator-token (sudo cat it to hold the switch)"
fi
echo "install: brain on $compute: $LLAMA_FLAGS"
systemctl daemon-reload

/opt/agent-civ/renew-tls.sh
systemctl enable --now agent-civ-renew.timer
systemctl enable agent-civ-llm.service agent-civ.service
systemctl start agent-civ-llm.service
systemctl start agent-civ.service
