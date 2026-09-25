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

install -d -m 0755 /opt/agent-civ/models /opt/agent-civ/llama.cpp
install -m 0755 dist/agentciv deploy/renew-tls.sh /opt/agent-civ/
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
  # Performance cores run at the top clock and show two threads per core; count the cores, not the threads.
  top=$(lscpu -e=MAXMHZ | tail -n +2 | sort -n | tail -1)
  pcores=$(lscpu -e=CORE,MAXMHZ | tail -n +2 | awk -v top="$top" '$2 == top {print $1}' | sort -u | wc -l)
  cores=$(lscpu -e=CORE | tail -n +2 | sort -u | wc -l)
  [[ $pcores -gt 0 ]] || pcores=$cores
  compute="cpu ($pcores performance cores of $cores)"
  # q8 KV halves the cache; flash attention is what allows the quantised V cache on CPU.
  LLAMA_FLAGS="-t $pcores -tb $cores -fa on -ctk q8_0 -ctv q8_0"
fi
LLAMA_FLAGS="-m $MODEL_FILE --alias $(basename "$MODEL" .gguf | tr '[:upper:]' '[:lower:]' | sed -E 's/^huihui-//; s/-instruct//; s/\.i1-q4_0$//') -c $((SLOTS * CTX_PER_SLOT)) -np $SLOTS $LLAMA_FLAGS"
install -d -m 0755 /etc/agent-civ
printf 'LLAMA_FLAGS=%s\n' "$LLAMA_FLAGS" > /etc/agent-civ/llm.env
echo "install: brain on $compute: $LLAMA_FLAGS"
systemctl daemon-reload

/opt/agent-civ/renew-tls.sh
systemctl enable --now agent-civ-llm.service agent-civ-renew.timer
# Slice or ExecStart changes need a restart to take effect.
systemctl restart agent-civ-llm.service
systemctl enable agent-civ.service
systemctl restart agent-civ.service
