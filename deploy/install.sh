#!/usr/bin/env bash
# Install or update the LAN deployment on this workstation. Run as root from the
# repo root after `bun run build`. Idempotent; see deploy/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

LLAMA=${LLAMA_DIR:-/home/imma/projects/llm/.opt/llama.cpp}
MODEL=${MODEL:-/home/imma/projects/llm/models/mlabonne_Qwen3-1.7B-abliterated-Q4_0.gguf}

[[ $EUID -eq 0 ]] || { echo "install: run as root" >&2; exit 1; }
[[ -x dist/agentciv ]] || { echo "install: dist/agentciv missing; run bun run build" >&2; exit 1; }
[[ -f /etc/agent-civ/approle.env ]] || { echo "install: /etc/agent-civ/approle.env missing; see deploy/README.md" >&2; exit 1; }

install -d -m 0755 /opt/agent-civ/models /opt/agent-civ/llama.cpp
install -m 0755 dist/agentciv deploy/renew-tls.sh /opt/agent-civ/
cp -a "$LLAMA/bin" "$LLAMA/lib" /opt/agent-civ/llama.cpp/
install -m 0644 "$MODEL" /opt/agent-civ/models/
install -m 0644 deploy/agent-civ{,-llm,-renew}.service deploy/agent-civ-renew.timer /etc/systemd/system/
systemctl daemon-reload

/opt/agent-civ/renew-tls.sh
systemctl enable --now agent-civ-llm.service agent-civ-renew.timer
systemctl enable agent-civ.service
systemctl restart agent-civ.service
