#!/usr/bin/env bash
# Self-test of scripts/devices-e2e.mjs on this machine: two headless nodes (agent-node.mjs from
# scripts/build-headless.mjs) on 127.0.0.1, a scripted fake AI, and the harness as the phone.
#
#   bash scripts/devices-e2e-local.sh <path to agent-node.mjs> [harness flags, e.g. --only a,b]
#
# Everything lives in a temp folder that is removed at the end. Nothing here names a real host or key.
set -u
NODE_BIN="${NODE_BIN:-node}"
AGENT_NODE="${1:?path to agent-node.mjs}"; shift
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
PORT_AI=$((18000 + RANDOM % 900)); PORT_A=$((19000 + RANDOM % 400)); PORT_B=$((19500 + RANDOM % 400))
cleanup() {
  for d in a b; do "$NODE_BIN" "$AGENT_NODE" stop --data-dir "$WORK/$d" >/dev/null 2>&1; done
  kill "$AI_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

"$NODE_BIN" "$HERE/devices-e2e-fake-ai.mjs" --port "$PORT_AI" >"$WORK/ai.log" 2>&1 &
AI_PID=$!
sleep 1
printf 'test-key' >"$WORK/key"
start_node() { # dir port
  "$NODE_BIN" "$AGENT_NODE" config --data-dir "$WORK/$1" --listen 127.0.0.1 --port "$2" --url "https://127.0.0.1:$2" >/dev/null
  "$NODE_BIN" "$AGENT_NODE" account add api --provider openai --base-url "http://127.0.0.1:$PORT_AI/v1" --model fake-model --allow-http --data-dir "$WORK/$1" <"$WORK/key" >/dev/null
  "$NODE_BIN" "$AGENT_NODE" start --daemon --data-dir "$WORK/$1" >"$WORK/$1.start.log" 2>&1
}
start_node a "$PORT_A"
for i in $(seq 1 30); do curl -sk "https://127.0.0.1:$PORT_A/v1/health" | grep -q '"ready":true' && break; sleep 1; done
# B joins A as a second brain (paired while stopped), then starts.
"$NODE_BIN" "$AGENT_NODE" config --data-dir "$WORK/b" --listen 127.0.0.1 --port "$PORT_B" --url "https://127.0.0.1:$PORT_B" >/dev/null
LINK_B="$("$NODE_BIN" "$AGENT_NODE" offer --no-qr --data-dir "$WORK/a" | grep -o "agent://pair?[^ ]*" | head -1)"
"$NODE_BIN" "$AGENT_NODE" pair "$LINK_B" --data-dir "$WORK/b" || echo "(B could not pair with A)"
start_node b "$PORT_B"
for i in $(seq 1 30); do curl -sk "https://127.0.0.1:$PORT_B/v1/health" | grep -q '"ready":true' && break; sleep 1; done
# A picture on brain A for check d (a 1x1 PNG).
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' >"$WORK/a/e2e-picture.png"
# The phone pairs with A.
LINK="$("$NODE_BIN" "$AGENT_NODE" offer --no-qr --data-dir "$WORK/a" | grep -o "agent://pair?[^ ]*" | head -1)"
"$NODE_BIN" "$HERE/devices-e2e.mjs" --brain "https://127.0.0.1:$PORT_A" --brain "https://127.0.0.1:$PORT_B" --code "$LINK" \
  --state "$WORK/phone.json" --timeout 120 --make-project --image "$WORK/a/e2e-picture.png" \
  --stop-cmd "kill -9 \$(cat $WORK/a/agent-node.pid)" --stop-cmd "kill -9 \$(cat $WORK/b/agent-node.pid)" \
  --start-cmd "$NODE_BIN $AGENT_NODE start --daemon --data-dir $WORK/a" --start-cmd "$NODE_BIN $AGENT_NODE start --daemon --data-dir $WORK/b" \
  "$@"
STATUS=$?
echo "--- node A log (tail)"; tail -5 "$WORK/a.start.log" 2>/dev/null
exit $STATUS
