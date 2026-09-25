# LAN deployment: https://civ.imabee.com

Runs on the workstation `192.168.101.7` (`local.imabee.com`), reachable from the LAN.

| Piece | Where |
|---|---|
| Name | unbound on the NUC (`.253`/`::44`), `local-data` in nuc-k3s `apps/dns/10-configmap.yaml`. LAN-only, no Cloudflare record |
| TLS | Leaf from the AppSynergy Intermediate CA, Vault k2 `pki_int/issue/agent-civ` (this name only, EC, 1 year) |
| Game | `agent-civ.service`: `/opt/agent-civ/agentciv` on `192.168.101.7:443`, state in `/var/lib/agent-civ` |
| Brain | `agent-civ-llm.service`: llama-server on `127.0.0.1:8080`, `mlabonne/Qwen3-1.7B-abliterated` Q4_0, thinking off |
| Renewal | `agent-civ-renew.timer`, daily; reissues under 30 days left and restarts the game |

## Commands

```bash
bun run build && sudo ./deploy/install.sh     # install or update; idempotent
sudo /opt/agent-civ/renew-tls.sh              # force a check now
journalctl -u agent-civ -u agent-civ-llm -f
```

## Gotchas

- Bind is `192.168.101.7` only: `.130` on the same NIC is the apsy edge's `:443`.
- `/etc/agent-civ/approle.env` (root, 0600) holds the AppRole. It is node-bound
  because a timer cannot unlock secd. To rebuild the Vault side after a restore:
  `secd run --with vault=local/nuc/vault/k2 -- sudo --preserve-env=VAULT_TOKEN bash -c 'set -a; . /etc/agent-civ/approle.env; set +a; exec python3 <nuc-k3s>/scripts/vault-approle.py --addr k2.imabee.com --name agent-civ --domains civ.imabee.com --no-subdomains --ttl 8760h --key-type ec --role-id-env VAULT_ROLE_ID --secret-id-env VAULT_SECRET_ID'`
- Model choice is speed-gated for this CPU (i9-12900K, no GPU): ~35-40 tok/s and ~6 s
  per turn. Qwen3-4B-2507 abliterated was more coherent but ran at 18 tok/s with 11 s cold prompts.
- A host resolving through public DNS (the NUC itself) sees no record; that is the split.
- No auth on the game's control API: anyone on the LAN can change speed or reset.
