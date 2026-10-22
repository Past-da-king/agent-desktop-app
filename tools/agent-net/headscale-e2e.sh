#!/usr/bin/env bash
# Live check of agent-net against a real Headscale, user space only (no root, no system Tailscale).
# Downloads Headscale into a temp dir, runs it on loopback, makes a user and a pre-auth key, starts two agent-net
# nodes (the key goes in on stdin), and proves an HTTP round trip node-b -> SOCKS -> overlay -> node-a -> local
# web server. Then node-b exits with --logout-on-exit and the script checks it left the tailnet.
# Needs: curl, python3, internet (Headscale download and Tailscale's public DERP map).
# Usage: ./headscale-e2e.sh <path-to-agent-net-linux-binary>
set -euo pipefail
BIN="$(realpath "${1:?agent-net binary}")"
HS_VERSION="${HS_VERSION:-0.29.5}"
WORK="$(mktemp -d)"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; sleep 1; rm -rf "$WORK"; }
trap cleanup EXIT
port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
HS_PORT=$(port); MET_PORT=$(port); GRPC_PORT=$(port); WEB_PORT=$(port)

curl -fsSL -o "$WORK/headscale" "https://github.com/juanfont/headscale/releases/download/v${HS_VERSION}/headscale_${HS_VERSION}_linux_amd64"
chmod +x "$WORK/headscale"
cat > "$WORK/config.yaml" <<EOF
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
  ephemeral:
    inactivity_timeout: 30m
database:
  type: sqlite
  sqlite:
    path: ${WORK}/db.sqlite
    write_ahead_log: true
log:
  level: warn
  format: text
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
HS="$WORK/headscale -c $WORK/config.yaml"
$HS serve > "$WORK/headscale.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 50); do [ -S "$WORK/headscale.sock" ] && break; sleep 0.2; done
$HS users create e2e > /dev/null
USER_ID=$($HS users list -o json | python3 -c 'import json,sys;print([u["id"] for u in json.load(sys.stdin) if u["name"]=="e2e"][0])')
KEY=$($HS preauthkeys create --user "$USER_ID" --reusable --expiration 1h -o json | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')

mkdir -p "$WORK/www" && echo "hello from node-a over headscale" > "$WORK/www/index.html"
python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 --directory "$WORK/www" > /dev/null 2>&1 & PIDS+=($!)

printf '%s\n' "$KEY" | "$BIN" --control-url "http://127.0.0.1:${HS_PORT}" --authkey-stdin --hostname e2e-node-a \
  --state-dir "$WORK/a" --forward "$WEB_PORT" --listen-port 7787 > "$WORK/a.jsonl" 2> "$WORK/a.err" & PIDS+=($!)
printf '%s\n' "$KEY" | "$BIN" --control-url "http://127.0.0.1:${HS_PORT}" --authkey-stdin --hostname e2e-node-b \
  --state-dir "$WORK/b" --socks 127.0.0.1:0 --logout-on-exit > "$WORK/b.jsonl" 2> "$WORK/b.err" & B_PID=$!; PIDS+=($B_PID)
KEY=""

last() { { tail -n 50 "$1" | grep "\"type\":\"status\"" | tail -1; } || true; }
field() { python3 -c "import json,sys;d=json.loads(sys.argv[1] or '{}');print(eval(sys.argv[2]))" "$1" "$2" 2>/dev/null || true; }
for i in $(seq 1 120); do
  A=$(last "$WORK/a.jsonl"); B=$(last "$WORK/b.jsonl")
  if [ "$(field "$A" 'd.get("state")')" = Running ] && [ "$(field "$B" 'any(p["name"]=="e2e-node-a" for p in d.get("peers",[]))')" = True ]; then break; fi
  sleep 0.5
done
A=$(last "$WORK/a.jsonl"); B=$(last "$WORK/b.jsonl")
A_IP=$(field "$A" 'd["tailnetIPs"][0]'); A_DNS=$(field "$A" 'd.get("dnsName","")'); SOCKS=$(field "$B" 'd["socks"]')
echo "node-a state=$(field "$A" 'd["state"]') ip=$A_IP dns=$A_DNS"
echo "node-b state=$(field "$B" 'd["state"]') socks=$SOCKS peers=$(field "$B" 'len(d["peers"])')"
[ -n "$A_IP" ] && [ -n "$SOCKS" ] || { echo "FAIL: nodes did not come up"; cat "$WORK/a.jsonl" "$WORK/b.jsonl" | tail -5; exit 1; }

OK=""
for i in $(seq 1 30); do
  if OUT=$(curl -fsS --max-time 10 --socks5-hostname "$SOCKS" "http://${A_IP}:7787/"); then OK=1; break; fi
  sleep 1
done
[ -n "$OK" ] || { echo "FAIL: no round trip through the overlay"; exit 1; }
echo "socks5 by IP: $OUT"
OUT2=$(curl -fsS --max-time 10 --proxy "http://$SOCKS" -p "http://${A_IP}:7787/")
echo "http connect by IP: $OUT2"
if [ -n "$A_DNS" ]; then
  OUT3=$(curl -fsS --max-time 10 --socks5-hostname "$SOCKS" "http://${A_DNS}:7787/") && echo "socks5 by MagicDNS name: $OUT3"
fi
grep -q 'tskey\|hskey' "$WORK"/a.* "$WORK"/b.* && { echo "FAIL: key text found in node output"; exit 1; }

kill -TERM "$B_PID"; wait "$B_PID" || true
tail -1 "$WORK/b.jsonl"
sleep 2
$HS nodes list -o json > "$WORK/nodes.json"
python3 - "$WORK/nodes.json" <<'PY' || exit 1
import json, sys, datetime
nodes = json.load(open(sys.argv[1])) or []
for n in nodes:
    name = n.get("given_name") or n.get("name", "")
    exp = n.get("expiry") or {}
    print(f"node {name}: online={n.get('online', False)} expiry={exp}")
b = [n for n in nodes if (n.get("given_name") or n.get("name")) == "e2e-node-b"]
now = datetime.datetime.now(datetime.timezone.utc).timestamp()
def gone(n):
    exp = n.get("expiry") or {}
    secs = int(exp.get("seconds", 0)) if isinstance(exp, dict) else 0
    return (0 < secs <= now) and not n.get("online", False)
if b and not gone(b[0]):
    print("FAIL: node-b still active after logout")
    sys.exit(1)
print("node-b logged out (removed or expired)")
PY
echo "HEADSCALE E2E PASSED"
