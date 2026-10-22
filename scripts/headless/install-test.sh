#!/bin/bash
# Sandboxed test of install.sh: temp HOME, fake crontab (a file), no systemd. Never touches the real crontab.
set -e
TGZ="$1"
S=$(mktemp -d)
mkdir -p "$S/bin" "$S/home"
cat > "$S/bin/crontab" <<EOF
#!/bin/sh
F="$S/cron"
# Like the real one: -l prints the table, a file argument (or - for stdin) replaces it.
if [ "\$1" = -l ]; then [ -f "\$F" ] && cat "\$F" || exit 1; elif [ "\$1" = - ]; then cat > "\$F.tmp" && mv "\$F.tmp" "\$F"; else cp "\$1" "\$F"; fi
EOF
printf '#!/bin/sh\nexit 1\n' > "$S/bin/systemctl"
chmod +x "$S/bin/"*
echo '0 3 * * * /bin/true # existing line' > "$S/cron"
cd "$S" && tar xzf "$TGZ"
export HOME="$S/home" PATH="$S/bin:$PATH"
sh "$S/agent-node/install.sh" --port 17788
echo "--- crontab after install"; cat "$S/cron"
echo "--- status"; "$HOME/agent-node/bin/agent-node" status
echo "--- health"; curl -sk https://127.0.0.1:17788/v1/health; echo
echo "--- keepalive while running"; sh "$HOME/agent-node/keepalive.sh"; echo "keepalive exit=$?"
echo "--- kill -9, then keepalive restarts it"
kill -9 "$(cat "$HOME/.local/share/agent-node/agent-node.pid")"; sleep 1
sh "$HOME/agent-node/keepalive.sh"; sleep 1
"$HOME/agent-node/bin/agent-node" status | grep state
echo "--- reinstall over a running copy"; sh "$S/agent-node/install.sh" >/dev/null; "$HOME/agent-node/bin/agent-node" status | grep state
echo "--- crontab after reinstall"; cat "$S/cron"
echo "--- uninstall"; sh "$HOME/agent-node/install.sh" --uninstall
echo "--- crontab after uninstall"; cat "$S/cron"
ls "$HOME/agent-node/backups" | head -3
pkill -f "$S/home/agent-node" || true; sleep 1; rm -rf "$S"
