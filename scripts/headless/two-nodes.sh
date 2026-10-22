#!/bin/bash
# Two headless nodes on this machine: pair, join, then show both logs and device rows. Uses the codex plan only for
# nothing: no AI calls. Leaves nothing behind.
source ~/.nvm/nvm.sh
B=~/agent-desktop-wt/devices-headless/dist-headless/agent-node.mjs
ONE=$(mktemp -d); TWO=$(mktemp -d)
P1=$((20000 + RANDOM % 20000)); P2=$((P1 + 1))
node $B account add codex --data-dir $ONE >/dev/null
node $B config --port $P1 --url https://127.0.0.1:$P1 --data-dir $ONE >/dev/null
node $B config --port $P2 --url https://127.0.0.1:$P2 --data-dir $TWO >/dev/null
node $B start --daemon --data-dir $ONE >/dev/null
node $B start --daemon --data-dir $TWO >/dev/null
LINK=$(node $B offer --no-qr --data-dir $ONE | awk '/Pairing link/{print $3}')
node $B pair "$LINK" --data-dir $TWO
sleep 20
echo "--- one devices"; node $B devices --data-dir $ONE
echo "--- two devices"; node $B devices --data-dir $TWO
echo "--- one log"; grep -v 'Browser\|Starting' $ONE/logs/main.log | cut -c1-220 | tail -15
echo "--- two log"; grep -v 'Browser\|Starting' $TWO/logs/main.log | cut -c1-220 | tail -15
echo "--- two node.out"; tail -5 $TWO/logs/node.out
node $B stop --data-dir $ONE >/dev/null; node $B stop --data-dir $TWO >/dev/null
rm -rf $ONE $TWO
