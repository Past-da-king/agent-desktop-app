#!/bin/sh
# Installs agent-node for this user only: no root, nothing outside your home.
#
#   ./install.sh [--node /path/to/node] [--port 7787] [--listen 127.0.0.1] [--data-dir DIR] [--no-start]
#   ./install.sh --uninstall          stop it and remove the keepalive (your data stays)
#
# Files go to ~/agent-node (AGENT_NODE_HOME), data to ~/.local/share/agent-node (AGENT_DATA_DIR).
# It keeps itself running with a systemd user service when the user may run services while logged out (lingering),
# otherwise with two crontab lines (@reboot and every 5 minutes) that start it only when it is not running.
set -eu

HOME_DIR="${AGENT_NODE_HOME:-$HOME/agent-node}"
DATA_DIR="${AGENT_DATA_DIR:-$HOME/.local/share/agent-node}"
NODE_BIN="${AGENT_NODE_BIN:-}"
PORT=""
LISTEN=""
START=1
UNINSTALL=0
TAG="# agent-node keepalive"

while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE_BIN="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --listen) LISTEN="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

node_ok() {
  [ -x "$1" ] || return 1
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null
}

find_node() {
  if [ -n "$NODE_BIN" ]; then node_ok "$NODE_BIN" && { echo "$NODE_BIN"; return 0; }; echo "That node is too old or missing: $NODE_BIN" >&2; return 1; fi
  for c in "$(command -v node 2>/dev/null || true)" "$HOME"/node-v2[2-9]*/bin/node "$HOME"/node2[2-9]/bin/node "$HOME"/.nvm/versions/node/v2[2-9]*/bin/node /usr/local/bin/node; do
    [ -n "$c" ] && node_ok "$c" && { echo "$c"; return 0; }
  done
  echo "agent-node needs Node 22.13 or newer. Install one in your home and pass --node /path/to/bin/node." >&2
  return 1
}

find_tool() {
  for c in "$(command -v "$1" 2>/dev/null || true)" "$HOME/.local/bin/$1" "$HOME/bin/$1"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  echo ""
}

have_user_systemd() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1 || return 1
  [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" = "yes" ]
}

# Crontab edits read the whole table into a file first, then install it: other lines are never lost.
remove_cron() {
  if command -v crontab >/dev/null 2>&1 && crontab -l >/dev/null 2>&1; then
    TMP_CRON="$(mktemp)"
    crontab -l > "$TMP_CRON"
    if grep -q "$TAG" "$TMP_CRON"; then
      grep -v "$TAG" "$TMP_CRON" > "$TMP_CRON.new" || true
      crontab "$TMP_CRON.new"
    fi
    rm -f "$TMP_CRON" "$TMP_CRON.new"
  fi
}

if [ "$UNINSTALL" = 1 ]; then
  [ -x "$HOME_DIR/bin/agent-node" ] && "$HOME_DIR/bin/agent-node" stop || true
  if have_user_systemd && [ -f "$HOME/.config/systemd/user/agent-node.service" ]; then
    systemctl --user disable --now agent-node.service || true
    rm -f "$HOME/.config/systemd/user/agent-node.service"
    systemctl --user daemon-reload || true
  fi
  remove_cron
  echo "Stopped and removed the keepalive. Files stay in $HOME_DIR, data in $DATA_DIR."
  exit 0
fi

NODE="$(find_node)"
CLAUDE="$(find_tool claude)"
CODEX="$(find_tool codex)"

# Stop a running copy before its files are replaced; the keepalive brings the new one up.
if [ -x "$HOME_DIR/bin/agent-node" ]; then "$HOME_DIR/bin/agent-node" stop >/dev/null 2>&1 || true; fi

mkdir -p "$HOME_DIR/bin" "$DATA_DIR"
chmod 700 "$DATA_DIR"
if [ "$SRC_DIR" != "$HOME_DIR" ]; then
  rm -rf "$HOME_DIR/node_modules"
  cp -R "$SRC_DIR/agent-node.mjs" "$SRC_DIR/package.json" "$SRC_DIR/README.md" "$SRC_DIR/install.sh" "$SRC_DIR/node_modules" "$HOME_DIR/"
fi

cat > "$HOME_DIR/bin/agent-node" <<EOF
#!/bin/sh
# Written by install.sh. Run it as: agent-node start|stop|status|pair|devices
export AGENT_DATA_DIR="\${AGENT_DATA_DIR:-$DATA_DIR}"
export PATH="$(dirname "$NODE"):\$HOME/.local/bin:\$PATH"
${CLAUDE:+export AGENT_CLAUDE_PATH="\${AGENT_CLAUDE_PATH:-$CLAUDE}"}
${CODEX:+export AGENT_CODEX_PATH="\${AGENT_CODEX_PATH:-$CODEX}"}
export NODE_OPTIONS="\${NODE_OPTIONS:---max-old-space-size=512}"
exec "$NODE" "$HOME_DIR/agent-node.mjs" "\$@"
EOF
chmod 755 "$HOME_DIR/bin/agent-node"

cat > "$HOME_DIR/keepalive.sh" <<EOF
#!/bin/sh
# Written by install.sh: starts agent-node when it is not running. Safe to run any time.
"$HOME_DIR/bin/agent-node" status 2>/dev/null | grep -q '^state: running' && exit 0
exec "$HOME_DIR/bin/agent-node" start --daemon >> "$DATA_DIR/keepalive.log" 2>&1
EOF
chmod 755 "$HOME_DIR/keepalive.sh"

# First run: the listen address and port go into the node's own config.
FIRST_ARGS=""
[ -n "$PORT" ] && FIRST_ARGS="$FIRST_ARGS --port $PORT"
[ -n "$LISTEN" ] && FIRST_ARGS="$FIRST_ARGS --listen $LISTEN"

# shellcheck disable=SC2086
[ -n "$FIRST_ARGS" ] && "$HOME_DIR/bin/agent-node" config $FIRST_ARGS

if have_user_systemd; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/agent-node.service" <<EOF
[Unit]
Description=agent-node (the agent as a service)
After=network-online.target

[Service]
ExecStart=$HOME_DIR/bin/agent-node start
Restart=always
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=40

[Install]
WantedBy=default.target
EOF
  remove_cron
  systemctl --user daemon-reload
  if [ "$START" = 1 ]; then systemctl --user enable --now agent-node.service; else systemctl --user enable agent-node.service; fi
  KEEP="systemd user service agent-node.service"
else
  if command -v crontab >/dev/null 2>&1; then
    mkdir -p "$HOME_DIR/backups"
    BACKUP="$HOME_DIR/backups/crontab.$(date +%Y%m%d-%H%M%S)"
    crontab -l > "$BACKUP" 2>/dev/null || : > "$BACKUP"
    TMP_CRON="$(mktemp)"
    { grep -v "$TAG" "$BACKUP" || true
      echo "@reboot $HOME_DIR/keepalive.sh $TAG"
      echo "*/5 * * * * $HOME_DIR/keepalive.sh $TAG"
    } > "$TMP_CRON"
    # Never install a table that lost lines it had.
    KEPT="$(grep -vc "$TAG" "$BACKUP" || true)"
    NOW="$(grep -vc "$TAG" "$TMP_CRON" || true)"
    if [ "$KEPT" != "$NOW" ]; then echo "Refusing to change the crontab: it would lose lines. Nothing was changed." >&2; rm -f "$TMP_CRON"; exit 1; fi
    crontab "$TMP_CRON"
    rm -f "$TMP_CRON"
    KEEP="crontab (@reboot and every 5 minutes)"
  else
    KEEP="none (no systemd user service and no crontab here: start it yourself)"
  fi
  if [ "$START" = 1 ]; then
    "$HOME_DIR/bin/agent-node" start --daemon
  fi
fi

echo "Installed agent-node $("$HOME_DIR/bin/agent-node" version) in $HOME_DIR"
echo "Node: $NODE"
[ -n "$CLAUDE" ] && echo "Claude engine: $CLAUDE"
echo "Keepalive: $KEEP"
echo "Data: $DATA_DIR"
echo "Next: $HOME_DIR/bin/agent-node status, then pair it from your desktop (Settings > Devices > Add a device):"
echo "      $HOME_DIR/bin/agent-node pair 'agent://pair?...'"
