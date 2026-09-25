# LAN deployment: https://civ.imabee.com

Runs on the workstation `192.168.101.7` (`local.imabee.com`), reachable from the LAN.

| Piece | Where |
|---|---|
| Name | unbound on the NUC (`.253`/`::44`), `local-data` in nuc-k3s `apps/dns/10-configmap.yaml`. LAN-only, no Cloudflare record |
| TLS | Leaf from the AppSynergy Intermediate CA, Vault k2 `pki_int/issue/agent-civ` (this name only, EC, 1 year) |
| Game | `agent-civ.service`: `/opt/agent-civ/agentciv` on `192.168.101.7:443`, state in `/var/lib/agent-civ` |
| Brain | `agent-civ-llm.service`: llama-server on `127.0.0.1:8080`, `huihui-ai/Huihui-Qwen3-4B-Instruct-2507-abliterated` i1-Q4_0, 12 slots of 6144 ctx (one per node). Flags in `/etc/agent-civ/llm.env`, written by `install.sh` from the compute it finds: a GPU with room for the model takes every layer, otherwise the performance cores decode with a q8 KV cache |
| Renewal | `agent-civ-renew.timer`, daily; reissues under 30 days left and restarts the game |
| CPU | both services run in `agentciv.slice` (`CPUWeight=200`): about half the CPU when your builds saturate the box, nothing extra when it is idle |
| History | `/var/lib/agent-civ/history.sqlite`: routine rows (moves, gathers, rests) kept 7 days; everything else and every prompt/reply kept forever |

## Commands

```bash
bun run build && sudo ./deploy/install.sh     # install or update; idempotent; refuses a Bun other than .bun-version
sudo /opt/agent-civ/renew-tls.sh              # force a check now
journalctl -u agent-civ -u agent-civ-llm -f
```

## Gotchas

- Bind is `192.168.101.7` only: `.130` on the same NIC is the apsy edge's `:443`.
- `install.sh` stops both services before it copies anything: a mapped binary replaced under a running
  process dies with SIGBUS (it happened once, 85 s into a shutdown that had hung). The game exits within
  10 s of SIGTERM on its own; `TimeoutStopSec=30` is the backstop.
- `/etc/agent-civ/approle.env` (root, 0600) holds the AppRole. It is node-bound
  because a timer cannot unlock secd. To rebuild the Vault side after a restore:
  `secd run --with vault=local/nuc/vault/k2 -- sudo --preserve-env=VAULT_TOKEN bash -c 'set -a; . /etc/agent-civ/approle.env; set +a; exec python3 <nuc-k3s>/scripts/vault-approle.py --addr k2.imabee.com --name agent-civ --domains civ.imabee.com --no-subdomains --ttl 8760h --key-type ec --role-id-env VAULT_ROLE_ID --secret-id-env VAULT_SECRET_ID'`
- Model: on the neutral prompt (no example strategy) Qwen3-4B-2507 wrote coherent, varied code on 6/6
  turns; Qwen3-1.7B 2/6 (placeholders), Llama-3.2-3B mostly invalid JS, Qwen2.5-3B 2/6.
- Concurrency: on this CPU (i9-12900K, no GPU) one stream decodes at 17 tok/s and prefills at 110 to 130
  tok/s; three streams at once drop to 4 to 7 tok/s each and 46 to 89 tok/s prefill, and a turn takes
  longer in wall time (35 s vs 29 s on the same prompts). `--concurrency 3` is therefore only a ceiling:
  the engine probes the backend at start, classifies it from its own timings (bandwidth-bound or fast),
  starts one turn at a time when bandwidth-bound, and tries the next level up every few turns, keeping
  it only when measured throughput improves. The Pacing tab shows the level and the rates.
- KV cache: each living node is pinned to its own llama-server slot (`id_slot`, `cache_prompt`), and the
  prompt puts the node's files and code before the changing facts, so a turn re-reads only what changed
  since that node's last turn. 12 slots × 6144 ctx of f16 KV is ~11 GB RAM; before pinning, ~40% of each
  prompt was reused (`f_keep` in the llm journal), the rest re-prefilled.
- A host resolving through public DNS (the NUC itself) sees no record; that is the split.
- `--max-agents 12`: every extra node slows the paced clock; past `--max-tick-ms` turns space out instead.
- Controls need the operator token: `/etc/agent-civ/operator-token` (root, 0600, made by `install.sh`;
  `sudo cat` it). The UI asks for it once per browser session ("watch only" badge → "operator") and
  forgets it when the server refuses it; over REST it is a bearer header. Reads stay open to the LAN.
  A reset still also needs the word RESET; every control is logged with the caller's address.
