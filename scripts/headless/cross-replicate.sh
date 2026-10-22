#!/bin/bash
# Cross-machine join + replication. A temp node in WSL ("home", has a memory and an AI account); a temp node on the
# server (via ssh host $1) pairs with it and joins; the memory must arrive in the server node's database.
# The server reaches the tailnet only through its SOCKS5 port ($2, e.g. socks5://localhost:1055).
# Addresses are read at run time; nothing is written into the repo.
HOST="${1:?ssh host of the server}"
PROXY="${2:-}"
source ~/.nvm/nvm.sh
B=~/agent-desktop-wt/devices-headless/dist-headless/agent-node.mjs
SELF=$(tailscale ip -4 | head -1)
ONE=$(mktemp -d)
P1=$((20000 + RANDOM % 20000))
node $B account add codex --data-dir $ONE >/dev/null
# A memory on the home node (one real turn on its plan) before it starts.
node $B ask "Save a memory titled CrossCheck with the body: written at home. Reply only: saved." --data-dir $ONE | tail -1
node $B config --listen 0.0.0.0 --port $P1 --url "https://$SELF:$P1" --data-dir $ONE >/dev/null
node $B start --daemon --data-dir $ONE >/dev/null || { echo "home node did not start"; exit 1; }
LINK=$(node $B offer --no-qr --data-dir $ONE | awk '/Pairing link/{print $3}')
echo "home node up"
timeout 200 ssh -o BatchMode=yes "$HOST" "
  export AGENT_NODE_PROXY=$PROXY
  N=~/agent-node/bin/agent-node; S=\$(mktemp -d); P=\$((40000 + RANDOM % 9000))
  \$N config --port \$P --proxy '$PROXY' --data-dir \$S >/dev/null
  \$N start --daemon --data-dir \$S >/dev/null
  \$N pair '$LINK' --data-dir \$S 2>&1 | sed 's/https:[^ ]*/<home>/'
  \$N status --data-dir \$S | tail -1
  sleep 25
  \$N devices --data-dir \$S
  ~/node-v24.15.0-linux-x64/bin/node --input-type=module -e \"
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(process.argv[1] + '/agent.db', { readOnly: true })
    import { readFileSync } from 'node:fs'
    const rows = db.prepare(\\\"SELECT payload FROM rows WHERE entity = 'memory' AND deleted = 0\\\").all()
    const accounts = JSON.parse(readFileSync(process.argv[1] + '/settings.json', 'utf8')).accounts
    console.log('server temp node: CrossCheck memory arrived:', rows.some((r) => r.payload.includes('CrossCheck')), '| accounts from bundle:', (accounts || []).map((a) => a.kind).join(','))
  \" \$S 2>&1 | tail -1
  grep -c 'could not reach' \$S/logs/main.log
  \$N stop --data-dir \$S >/dev/null; rm -rf \$S
"
echo "--- home log"
grep -E 'paired|could not reach' $ONE/logs/main.log | cut -c1-160 | tail -4
node $B stop --data-dir $ONE >/dev/null
rm -rf $ONE
