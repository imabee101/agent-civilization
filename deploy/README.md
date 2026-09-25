# LAN deployment: https://civ.imabee.com

Runs on the workstation `192.168.101.7` (`local.imabee.com`), reachable from the LAN.

| Piece | Where |
|---|---|
| Name | unbound on the NUC (`.253`/`::44`), `local-data` in nuc-k3s `apps/dns/10-configmap.yaml`. LAN-only, no Cloudflare record |
| TLS | Leaf from the AppSynergy Intermediate CA, Vault k2 `pki_int/issue/agent-civ` (this name only, EC, 1 year) |
| Game | `agent-civ.service`: `/opt/agent-civ/agentciv` on `192.168.101.7:443`, state in `/var/lib/agent-civ` |
| Brain | `agent-civ-llm.service`: llama-server on `127.0.0.1:8080`, `huihui-ai/Huihui-Qwen3-4B-Instruct-2507-abliterated` i1-Q4_0, 3 slots |
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
- Model: on the neutral prompt (no example strategy) Qwen3-4B-2507 wrote coherent, varied code on 6/6
  turns; Qwen3-1.7B 2/6 (placeholders), Llama-3.2-3B mostly invalid JS, Qwen2.5-3B 2/6. ~35 s per turn on
  this CPU (i9-12900K, no GPU); 3 slots give ~1.9x aggregate throughput, and the world clock paces to it.
- A host resolving through public DNS (the NUC itself) sees no record; that is the split.
- `--max-agents 12`: every extra node slows the paced clock; past `--max-tick-ms` turns space out instead.
- No auth on the game's control API: anyone on the LAN can pause, change speed or spawn. A reset is only possible by typing RESET into the dialog (or `POST /api/reset` with `{"confirm":"RESET"}`); the engine never resets on its own, and every reset is logged with the caller's address.
