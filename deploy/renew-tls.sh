#!/usr/bin/env bash
# Issue $DOMAIN from the Intermediate CA at $VAULT_ADDR (pki_int, role
# agent-civ) when the installed leaf has under 30 days left, then restart the
# game. Not ACME: the name resolves to an RFC1918 address. DOMAIN and
# VAULT_ADDR come from /etc/agent-civ/install.env.
#
# The AppRole in /etc/agent-civ/approle.env (root, 0600) may only issue this one
# name. It is node-bound because a timer cannot unlock secd. Values reach curl
# on stdin and are never echoed.
set -euo pipefail

DIR=/etc/agent-civ/tls
RENEW_BELOW_DAYS=${RENEW_BELOW_DAYS:-30}

die() { echo "renew-tls: $*" >&2; exit 1; }
. /etc/agent-civ/install.env
[[ -n "${DOMAIN:-}" && -n "${VAULT_ADDR:-}" ]] || die "DOMAIN and VAULT_ADDR must be set in /etc/agent-civ/install.env"
VAULT=$VAULT_ADDR
NAME=$DOMAIN
. /etc/agent-civ/approle.env
[[ -n "${VAULT_ROLE_ID:-}" && -n "${VAULT_SECRET_ID:-}" ]] || die "no AppRole in /etc/agent-civ/approle.env"

if [[ -f $DIR/fullchain.pem ]] && openssl x509 -in "$DIR/fullchain.pem" -noout -checkend $((RENEW_BELOW_DAYS * 86400)) >/dev/null; then
  echo "renew-tls: $NAME valid beyond ${RENEW_BELOW_DAYS}d, nothing to do"
  exit 0
fi

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

token=$(printf '{"role_id":"%s","secret_id":"%s"}' "$VAULT_ROLE_ID" "$VAULT_SECRET_ID" \
  | curl -sS --fail-with-body -X POST "$VAULT/auth/approle/login" --data @- \
  | python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin)["auth"]["client_token"])') \
  || die "AppRole login failed (is vault-k2 sealed?)"

curl -sS --fail-with-body -H @- -X POST "$VAULT/pki_int/issue/agent-civ" \
  --data "{\"common_name\":\"$NAME\",\"ttl\":\"8760h\"}" <<<"X-Vault-Token: $token" \
  > "$staging/issued.json" || die "issue failed"

python3 - "$staging" <<'PY'
import json, pathlib, sys
out = pathlib.Path(sys.argv[1])
d = json.loads((out / "issued.json").read_text())["data"]
chain, seen = [d["certificate"]], {d["certificate"]}
for c in d.get("ca_chain") or [d["issuing_ca"]]:
    if c not in seen:
        seen.add(c)
        chain.append(c)
(out / "fullchain.pem").write_text("\n".join(chain) + "\n")
(out / "key.pem").write_text(d["private_key"] + "\n")
PY

[[ $(openssl x509 -noout -pubkey -in "$staging/fullchain.pem" | openssl sha256) == \
   $(openssl pkey -pubout -in "$staging/key.pem" | openssl sha256) ]] || die "issued key does not match the certificate"

install -d -m 0700 "$DIR"
install -m 0644 "$staging/fullchain.pem" "$DIR/fullchain.pem"
install -m 0600 "$staging/key.pem" "$DIR/key.pem"
systemctl try-restart agent-civ.service
echo "renew-tls: renewed $NAME, $(openssl x509 -in "$DIR/fullchain.pem" -noout -enddate)"
