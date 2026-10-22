#!/bin/bash
# Live relay proof: a temp node in WSL ("home computer") on the tailnet; a temp data dir on the server pairs with it
# and its agent fetches a page through it. Addresses are read at run time and never written into the repo.
# Usage: relay-live.sh <ssh host of the server> [socks5://proxy as seen from the server]
HOST="${1:?ssh host of the server}"
PROXY="${2:-}"
source ~/.nvm/nvm.sh
B=~/agent-desktop-wt/devices-headless/dist-headless/agent-node.mjs
SELF=$(tailscale ip -4 2>/dev/null | head -1)
T=$(mktemp -d)
PORT=$((20000 + RANDOM % 30000))
node $B config --listen 0.0.0.0 --port $PORT --url "https://$SELF:$PORT" --data-dir $T >/dev/null
node $B start --daemon --data-dir $T >/dev/null || { echo "home node did not start"; exit 1; }
LINK=$(node $B offer --no-qr --data-dir $T | awk '/Pairing link/{print $3}')
echo "home node up; offer made"
timeout 300 ssh -o BatchMode=yes "$HOST" "export AGENT_NODE_PROXY=$PROXY; S=\$(mktemp -d); N=~/agent-node/bin/agent-node; \$N pair '$LINK' --data-dir \$S 2>&1 | head -1 | sed 's/https:[^ ]*/<home>/'; \$N account add codex --data-dir \$S >/dev/null 2>&1; timeout 240 \$N ask 'Use web_fetch_via_device to fetch https://example.com and reply with the first sentence of the page text, and say which computer it came through.' --data-dir \$S 2>&1 | tail -4; rm -rf \$S"
echo "--- home node log:"
grep -h 'Relay fetch' $T/logs/main.log | sed 's/"for":"[^"]*"/"for":"<server>"/' | tail -2
node $B stop --data-dir $T >/dev/null
rm -rf $T
