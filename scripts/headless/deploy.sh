#!/bin/bash
# One command from this machine to a Linux server you can ssh into: build the headless node, copy it, install it
# for that user (no root), start it and show its status.
#
#   bash scripts/headless/deploy.sh <ssh host> [--node /path/to/node/on/server] [--proxy socks5://host:port] [--port N]
#
# Run it again to update: the running copy is stopped, replaced and started; data and settings stay.
set -euo pipefail
HOST="${1:?usage: deploy.sh <ssh host> [--node PATH] [--proxy socks5://HOST:PORT] [--port N]}"
shift
NODE_ARG=""
PROXY=""
PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE_ARG="--node $2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
node scripts/build-headless.mjs | tail -1
TGZ="$(ls -t dist-headless/agent-node-*-linux.tgz | head -1)"
REMOTE_TGZ="/tmp/agent-node-deploy-$$.tgz"
scp -q "$TGZ" "$HOST:$REMOTE_TGZ"
# shellcheck disable=SC2029
ssh -o BatchMode=yes "$HOST" "set -e
  D=\$(mktemp -d)
  tar xzf '$REMOTE_TGZ' -C \"\$D\"
  rm -f '$REMOTE_TGZ'
  cd \"\$HOME\"
  sh \"\$D/agent-node/install.sh\" $NODE_ARG ${PORT:+--port $PORT} --no-start | grep -E 'Installed|Keepalive|Node:'
  rm -rf \"\$D\"
  N=\"\$HOME/agent-node/bin/agent-node\"
  ${PROXY:+\$N config --proxy '$PROXY' >/dev/null}
  \$N stop >/dev/null 2>&1 || true
  if [ -f \"\$HOME/.config/systemd/user/agent-node.service\" ]; then systemctl --user restart agent-node.service; else sh \"\$HOME/agent-node/keepalive.sh\"; fi
  for i in \$(seq 1 30); do \$N status | grep -q 'state: running' && break; sleep 1; done
  \$N status"
