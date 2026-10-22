#!/usr/bin/env bash
# Live check of the whole overlay path with the real pieces, user space only: a throwaway Headscale on loopback, the
# headless agent node from its tarball (agent-node.mjs with the agent-net helper packed beside it) switched to
# Network = Headscale with `agent-node net`, and a second agent-net node acting as another device. Proves the node
# joins, advertises its overlay address, answers GET /v1/health over the overlay (TLS through the forwarded port),
# and leaves the tailnet when switched back to None.
# Usage: ./headless-e2e.sh <agent-node-<v>-linux.tgz> [node binary, 22.13+]
set -euo pipefail
TGZ="$(realpath "${1:?tarball}")"
NODE="${2:-node}"
HS_VERSION="${HS_VERSION:-0.29.5}"
WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  [ -n "${AGENT_PID:-}" ] && kill "$AGENT_PID" 2>/dev/null || true
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  rm -rf "$WORK"
}
trap cleanup EXIT
port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
HS_PORT=$(port); MET_PORT=$(port); GRPC_PORT=$(port); NODE_PORT=$(port)

tar xzf "$TGZ" -C "$WORK"
APP="$WORK/agent-node"
[ -x "$APP/agent-net" ] || { echo "FAIL: the tarball has no agent-net helper"; exit 1; }
echo "tarball: agent-node.mjs + agent-net ($(stat -c %s "$APP/agent-net") bytes)"

curl -fsSL -o "$WORK/headscale" "https://github.com/juanfont/headscale/releases/download/v${HS_VERSION}/headscale_${HS_VERSION}_linux_amd64"
chmod +x "$WORK/headscale"
cat > "$WORK/hs.yaml" <<EOF
server_url: http://127.0.0.1:${HS_PORT}
listen_addr: 127.0.0.1:${HS_PORT}
metrics_listen_addr: 127.0.0.1:${MET_PORT}
grpc_listen_addr: 127.0.0.1:${GRPC_PORT}
grpc_allow_insecure: false
noise:
  private_key_path: ${WORK}/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: false
disable_check_updates: true
node:
  expiry: 0
database:
  type: sqlite
  sqlite:
    path: ${WORK}/db.sqlite
log:
  level: warn
policy:
  mode: file
  path: ""
dns:
  magic_dns: true
  base_domain: hs-test.example
  override_local_dns: false
  nameservers:
    global: []
unix_socket: ${WORK}/headscale.sock
unix_socket_permission: "0770"
logtail:
  enabled: false
EOF
HS="$WORK/headscale -c $WORK/hs.yaml"
$HS serve > "$WORK/headscale.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 50); do [ -S "$WORK/headscale.sock" ] && break; sleep 0.2; done
$HS users create e2e > /dev/null
USER_ID=$($HS users list -o json | python3 -c 'import json,sys;print([u["id"] for u in json.load(sys.stdin) if u["name"]=="e2e"][0])')
$HS preauthkeys create --user "$USER_ID" --reusable --expiration 1h -o json | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])' > "$WORK/key"
chmod 600 "$WORK/key"

# The headless node: own data dir, loopback, a free port. Network = Headscale, key on stdin, while it is stopped.
export AGENT_DATA_DIR="$WORK/data"
AN() { "$NODE" "$APP/agent-node.mjs" "$@"; }
AN config --listen 127.0.0.1 --port "$NODE_PORT" > /dev/null
AN net headscale "http://127.0.0.1:${HS_PORT}" < "$WORK/key"
grep -rq "$(cat "$WORK/key")" "$WORK/data" --include='*.json' && { echo "FAIL: key found in a json file"; exit 1; }
AN start > "$WORK/agent.log" 2>&1 & AGENT_PID=$!

# The other device: a plain agent-net node with a SOCKS proxy.
"$APP/agent-net" --control-url "http://127.0.0.1:${HS_PORT}" --authkey-stdin --hostname e2e-other --state-dir "$WORK/other" \
  --socks 127.0.0.1:0 < "$WORK/key" > "$WORK/other.jsonl" 2> /dev/null & PIDS+=($!)

last() { { tail -n 50 "$1" | grep '"type":"status"' | tail -1; } || true; }
field() { python3 -c "import json,sys;d=json.loads(sys.argv[1] or '{}');print(eval(sys.argv[2]))" "$1" "$2" 2>/dev/null || true; }
NODE_IP=""
for i in $(seq 1 120); do
  O=$(last "$WORK/other.jsonl")
  NODE_IP=$(field "$O" '[p["ips"][0] for p in d.get("peers",[]) if p["ips"] and p["online"]][0]')
  SOCKS=$(field "$O" 'd.get("socks","")')
  [ -n "$NODE_IP" ] && [ -n "$SOCKS" ] && break
  sleep 0.5
done
[ -n "$NODE_IP" ] || { echo "FAIL: the agent node did not show up on the overlay"; tail -20 "$WORK/agent.log"; exit 1; }
echo "agent node on the overlay: $(field "$O" '[p["name"]+" "+p["ips"][0] for p in d["peers"]]'), seen from e2e-other via socks $SOCKS"

OK=""
for i in $(seq 1 30); do
  if HEALTH=$(curl -fsSk --max-time 10 --socks5-hostname "$SOCKS" "https://${NODE_IP}:${NODE_PORT}/v1/health"); then OK=1; break; fi
  sleep 1
done
[ -n "$OK" ] || { echo "FAIL: /v1/health over the overlay"; tail -20 "$WORK/agent.log"; exit 1; }
echo "GET https://${NODE_IP}:${NODE_PORT}/v1/health over the overlay: $HEALTH"
# The pairing link carries the addresses the node advertises: the overlay one must be among them.
LINK=$(AN offer --no-qr | sed -n 's/^Pairing link: //p')
URLS=$(python3 -c 'import sys,urllib.parse as u;q=u.parse_qs(u.urlparse(sys.argv[1]).query);print(" ".join(x for v in q.get("u",[]) for x in v.split(",")))' "$LINK")
echo "advertised in the pairing link: $URLS"
case " $URLS " in *" https://${NODE_IP}:${NODE_PORT} "*) echo "the node advertises its overlay address" ;; *) echo "FAIL: overlay address not advertised"; exit 1 ;; esac

# Switch back to None while it runs: the helper logs out and the node leaves the tailnet.
AN net none
sleep 3
$HS nodes list -o json > "$WORK/nodes.json"
python3 - "$WORK/nodes.json" <<'PY' || exit 1
import json, sys, time
nodes = json.load(open(sys.argv[1])) or []
agent = [n for n in nodes if (n.get("given_name") or n.get("name", "")) != "e2e-other"]
for n in nodes:
    print(f"headscale node {n.get('given_name') or n.get('name')}: online={n.get('online', False)} expiry={n.get('expiry')}")
def gone(n):
    exp = n.get("expiry") or {}
    secs = int(exp.get("seconds", 0)) if isinstance(exp, dict) else 0
    return 0 < secs <= time.time() + 5 and not n.get("online", False)
if agent and not all(gone(n) for n in agent):
    print("FAIL: the agent node is still active after Network = None")
    sys.exit(1)
print("agent node logged out after Network = None")
PY
curl -fsSk --max-time 5 --socks5-hostname "$SOCKS" "https://${NODE_IP}:${NODE_PORT}/v1/health" > /dev/null 2>&1 && { echo "FAIL: still reachable over the overlay"; exit 1; }
echo "no longer reachable over the overlay"
curl -fsSk --max-time 5 "https://127.0.0.1:${NODE_PORT}/v1/health" > /dev/null && echo "still answers on loopback (the overlay was optional)"
echo "HEADLESS OVERLAY E2E PASSED"
