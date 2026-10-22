# agent-node

Your agent as a service, for a server or any computer without a screen. It is the same agent as the desktop app
(chats, memory, tasks, routines, helpers, connected apps), run by plain Node. Pair it with your desktop and it
becomes one more brain your phone and computers can use.

## Needs

- Linux, Node 22.13 or newer (it does not have to be the system Node: pass `--node`).
- `openssl` (it makes its own certificate on first start).
- For the Claude plan: Claude Code installed and signed in for this user (`claude` on the PATH or in
  `~/.local/bin`). For an API key account, nothing else.

No root. Everything stays in your home.

## Install

```sh
tar xzf agent-node-<version>-linux.tgz
cd agent-node
./install.sh                      # or: ./install.sh --node ~/node-v24/bin/node --port 7787
~/agent-node/bin/agent-node status
```

It listens on `https://127.0.0.1:7787` by default. To reach it from your other devices, either put it behind a
mesh VPN that forwards to loopback, or listen on all addresses (`--listen 0.0.0.0`) on a network you trust.

It keeps itself running: a systemd user service when your account may run services while logged out, otherwise two
crontab lines (`@reboot` and every 5 minutes) that start it only if it is not running. Your other crontab lines are
left as they are (a copy is saved in `~/agent-node/backups`).

## Pair it

On your desktop: Settings > Devices > Add a device. Then on this machine, either:

```sh
~/agent-node/bin/agent-node pair 'agent://pair?...'                     # the text of the QR code
~/agent-node/bin/agent-node pair --url https://desktop:7787 --code ABCD-EFGH
```

It joins your devices, takes over your settings and AI accounts from the desktop, and from then on keeps in step
with them. Restart it after pairing: `agent-node stop` (the keepalive starts it again) or `agent-node start --daemon`.

## Commands

| Command | What |
|---|---|
| `agent-node start [--daemon]` | run it (in the foreground, or in the background) |
| `agent-node stop` | stop it; a turn that is running may finish first |
| `agent-node status` | running or not, and whether it can answer |
| `agent-node pair ...` | join your devices |
| `agent-node devices` | the brains it is paired with |
| `agent-node config --listen ADDR --port N` | where it listens (next start) |

Data: `~/.local/share/agent-node` (or `--data-dir` / `AGENT_DATA_DIR`). Logs: `logs/` in there. Keys are kept
encrypted with a key file only your user can read.

## What it cannot do (yet)

- No browser of its own: the browser tools say they are not available here.
- No screen: links and files the agent wants to show you go to the device you asked from once it is paired.

## Remove

```sh
~/agent-node/install.sh --uninstall   # stops it and removes the keepalive; your data stays
```
