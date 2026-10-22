# agent-net

Optional overlay-network sidecar for the Agent app's Devices feature (protocol section 10). It embeds a
Tailscale-compatible node (tsnet) in user space: no system VPN, no admin rights, no separate Tailscale app. It joins
Tailscale or a self-hosted Headscale with an auth key, exposes the local node port on the overlay, and offers a local
SOCKS5 / HTTP CONNECT proxy that dials through the overlay. Devices never require it: LAN and direct addresses work
without it.

## Flags

| Flag | Meaning |
| --- | --- |
| `--control-url` | Control server. Empty = Tailscale's default. Set it for Headscale. |
| `--authkey-stdin` | Read the auth key from the first line of stdin. Otherwise env `AGENT_NET_AUTHKEY`. `--authkey` exists for manual use only; it shows in process lists, so the app never uses it. |
| `--hostname` | Name on the overlay. |
| `--state-dir` | Where the node keeps its identity. Required. |
| `--forward <port>` | Forward overlay TCP connections on `--listen-port` to `127.0.0.1:<port>`. |
| `--listen-port` | Overlay port for `--forward`, default 7787. |
| `--socks <addr>` | Local proxy address, e.g. `127.0.0.1:0` (0 = pick a free port; the chosen one is reported). |
| `--status <addr>` | Optional local HTTP endpoint, `GET /status` returns the latest status JSON. |
| `--ephemeral` | Register as an ephemeral node (removed by the control server soon after it goes away). |
| `--logout-on-exit` | Log the node out on SIGTERM/SIGINT, so it disappears from the tailnet. |
| `--stdin-control` | After the key line, read control lines on stdin: `quit`, `logout` (log out, then quit). stdin closing also quits, so the sidecar stops when its parent dies. This is how the app stops it on Windows, which has no SIGTERM. |
| `--verbose` | Embedded node logs to stderr. |

The auth key is never printed.

## Output

One JSON object per line on stdout, whenever something changes (and at most every few seconds while peers change):

```json
{"type":"status","state":"Running","tailnetIPs":["100.64.0.1"],"dnsName":"mynode.example.ts.net","socks":"127.0.0.1:41234","forward":{"port":7787,"to":7788},"peers":[{"name":"other","dnsName":"other.example.ts.net","ips":["100.64.0.2"],"online":true}]}
```

`state` is the backend state (`NoState`, `NeedsLogin`, `NeedsMachineAuth`, `Starting`, `Running`, `Stopped`).
When the control server wants an interactive login, `authURL` is set. Fatal problems print
`{"type":"error","error":"..."}` and exit non-zero. On SIGTERM it prints `{"type":"exit"}` and exits 0.

## Build

Go 1.25+, CGO off. `./build.sh` cross-compiles into `dist/` for linux-amd64, linux-arm64, windows-amd64,
darwin-arm64 and darwin-amd64.

## Test

`go test ./...` starts an in-process test control server and DERP relay (no internet, no root, no auth key), builds
this binary, runs two copies, and proves a TCP round trip through `--forward` and through `--socks` (SOCKS5 and HTTP
CONNECT), plus the status lines and clean exit on SIGTERM.
