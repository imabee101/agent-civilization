# LAN deployment

One box runs the game and its brain as two systemd units. Nothing tracked here names the box: every
host value lives in `/etc/agent-civ/install.env` (untracked, root, no secrets), which `install.sh` reads.

| Variable | Meaning |
|---|---|
| `HOST`, `PORT` | address the game binds (default port 443) |
| `DOMAIN` | the TLS name; `renew-tls.sh` issues it from Vault |
| `VAULT_ADDR` | Vault base URL including `/v1`; needs `pki_int/issue/agent-civ` for this name and the AppRole in `approle.env` |
| `LLAMA_DIR` | a llama.cpp build with `bin/` and `lib/`; with `MODEL`, the local brain (optional for `BRAIN=grok`, installed and kept running whenever set) |
| `MODEL` | the GGUF to copy into `/opt/agent-civ/models` |
| `MODEL_ALIAS` | what the game calls it (default: the file name, lower case) |
| `GAME_FLAGS` | `--max-agents`, `--concurrency` (a ceiling), `--max-tokens`, `--temperature` |
| `SLOTS`, `CTX_PER_SLOT` | llama-server slots (one per node) and context each (defaults 12, 6144) |
| `BRAIN` | `local` (llama-server, default) or `grok` |
| `GROK_USER`, `GROK_MODEL` | `BRAIN=grok`: the user whose `grok login` the game borrows; model (default `grok-4.7`) |

| Piece | Where |
|---|---|
| TLS | Leaf from a Vault Intermediate CA, `pki_int/issue/agent-civ` (the one name, EC, 1 year) |
| Game | `agent-civ.service`: `/opt/agent-civ/agentciv` on `$HOST:$PORT`, state in `/var/lib/agent-civ`, flags in `/etc/agent-civ/game.env` (rendered) |
| Brain | `agent-civ-llm.service`: llama-server on `127.0.0.1:8080`. Flags in `/etc/agent-civ/llm.env`, written by `install.sh` from the compute it finds: a GPU with room for the model takes every layer, otherwise the performance cores decode with a q8 KV cache |
| Grok token | `BRAIN=grok`: `agent-civ-grok-token.timer` runs `grok-token.sh` as `GROK_USER` every 20 min; it has the CLI renew the sign-in and copies only the access token to `/run/agent-civ-grok/auth.json` (group `agentciv-grok`, which the game joins). The refresh token never leaves the user's home |
| Renewal | `agent-civ-renew.timer`, daily; reissues under 30 days left and restarts the game |
| CPU | both services run in `agentciv.slice` (`CPUWeight=200`): about half the CPU when your builds saturate the box, nothing extra when it is idle |
| History | `/var/lib/agent-civ/history.sqlite`: routine rows (moves, gathers, rests) kept 7 days; everything else and every prompt/reply kept forever |

## Commands

```bash
bun run build && sudo ./deploy/install.sh     # install or update; idempotent; refuses a Bun other than .bun-version
sudo ./deploy/install.sh --brain grok         # think with the sudo user's `grok login` (--grok-user, --grok-model)
sudo ./deploy/install.sh --brain local        # think with llama-server on this box (needs LLAMA_DIR, MODEL)
sudo ./deploy/install.sh --fresh              # archive world, history, backups to /var/lib/agent-civ-archive/<time>; new world
sudo /opt/agent-civ/renew-tls.sh              # force a check now
journalctl -u agent-civ -u agent-civ-llm -f
```

## Gotchas

- `install.sh` stops both services before it copies anything: a mapped binary replaced under a running
  process dies with SIGBUS (it happened once, 85 s into a shutdown that had hung). The game exits within
  10 s of SIGTERM on its own; `TimeoutStopSec=30` is the backstop.
- `/etc/agent-civ/approle.env` (root, 0600) holds the AppRole that may issue `$DOMAIN` and nothing
  else. It is node-bound because a timer cannot unlock secd. How it was made belongs in `install.env`'s
  comments on the box, not here.
- Model: on the neutral prompt (no example strategy) Qwen3-4B-2507 wrote coherent, varied code on 6/6
  turns; Qwen3-1.7B 2/6 (placeholders), Llama-3.2-3B mostly invalid JS, Qwen2.5-3B 2/6.
- Bench rows the current choice rests on (`bun run bench`, 8 stored prompts each, Qwen3-4B-2507 abliterated
  Q4_0, one turn at a time unless said; the three warm rows ran on a cache the baseline had filled, so only
  their decode-side columns compare):

  | configuration | turns/h | p50 | prefill | decode | threw | cut | comments |
  |---|---|---|---|---|---|---|---|
  | temperature 0.7, fence stop (cold cache) | 76 | 47 s | 19.4 s | 27.6 s | 13% | 13% | 12% |
  | temperature 0.4 (warm) | 96 | 38 s | 9.4 s | 27.9 s | 13% | 0% | 10% |
  | no fence stop (warm) | 98 | 42 s | 11.1 s | 25.3 s | 0% | 0% | 9% |
  | three at once (warm) | 113 | 96 s | 16.8 s | 73.7 s | 13% | 0% | 10% |
  | `--spec-type ngram-map-k` (cold, second server) | 51 | 80 s | 39.7 s | 31.3 s | 13% | 0% | 6% |

  Deployed: this model at temperature 0.4 with the fence stop (`GAME_FLAGS` sets it). N-gram speculation loses on this CPU. Three at once wins only with a warm cache, which is why the engine
  measures the level instead of fixing it. Not yet measured: a 1.7B draft model, Q4_K_M (stock and
  abliterated), Qwen3-Coder-30B-A3B; the files sit beside `MODEL` on the deploy box. Measure them one
  at a time with `agent-civ-llm` stopped: a second server beside the deployed one (19.5 GB with its idle
  KV and prompt cache) runs the box out of memory.
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
