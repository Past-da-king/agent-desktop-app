# Workstream E: optional overlay network (agent-net, tsnet)

Branch `devices-net` (off `devices`, with `devices-node` and `devices-headless-int` merged in so the Settings row and
the headless node could be wired), worktree `~/agent-desktop-wt/devices-net`. Status: DONE (22 Oct 2026, about 03:05).

## Done and proven
- `tools/agent-net` (Go 1.27, tailscale.com v1.104.2 tsnet): forward, SOCKS5 + HTTP CONNECT proxy, JSON status
  lines, status endpoint, stdin key and stdin control (quit, logout, EOF), SIGTERM, ephemeral, logout-on-exit.
  - `go test ./...` (on the build server, Go in ~/.local/go): in-process test control server + DERP; builds the real
    binary, runs two copies, round trips through --forward via SOCKS5 by IP, HTTP CONNECT, and MagicDNS name;
    status endpoint; quit/logout/EOF; key never in output. PASS.
  - `headscale-e2e.sh dist/agent-net-linux-amd64`: real Headscale 0.29.5 in a temp dir (user space), pre-auth key on
    stdin, two nodes, HTTP round trip by IP, CONNECT, MagicDNS; node-b logged out (expiry set, offline). PASSED.
  - `build.sh`: linux-amd64 22.3 MB, linux-arm64 20.6 MB, windows-amd64 22.5 MB, darwin-arm64 20.6 MB,
    darwin-amd64 22.1 MB (stripped, CGO off), plus `dist/electron/<os>-<arch>/` for electron-builder.
- `apps/desktop/src/main/devices/net.ts`: OverlayNet (settings file, key in secrets only, spawn with key on stdin,
  status parsing, backoff restart, quit/logout), findSidecar, overlay host detection, OS-route check, SOCKS5 client,
  `overlayDial`, `overlayCreateConnection`, `peerRequestOptions`.
- DevicesService: owns OverlayNet; runs it while the server listens; overlay urls in `status().urls`, own device row,
  pairing links; `setNetwork` IPC; `status().network`. Core types `DevicesNetwork`, `NetworkMode`,
  `DevicesNetworkInput`, `DevicesApi.setNetwork`; channel `devices.setNetwork` (not in RPC_ALLOWED).
- Settings > Devices > Network row (`views/DevicesNetwork.tsx`): None / Tailscale / Headscale + URL + auth key.
  `node scripts/devices-net-shoot.mjs` drives it on the mock bridge at 1280 and 390, light and dark: ok (no
  overflow, no tiny text, contrast ok, behaviour checked). Shots in `C:\temp\devnet\shots`.
- Headless: `agent-node net none|tailscale|headscale URL < keyfile` (control socket allows setNetwork), sidecar
  found next to agent-node.mjs; `scripts/build-headless.mjs` packs `agent-net` when built.
- Packaging: electron-builder `extraResources` from `tools/agent-net/dist/electron/${os}-${arch}`.
- Live, end to end: `tools/agent-net/headless-e2e.sh agent-node-0.2.38-linux.tgz <node>` on the server: the
  headless node from the real tarball, Network = Headscale (temp Headscale), reached from another overlay node:
  GET /v1/health over the overlay OK, overlay urls in the pairing link, `agent-node net none` logs it out, no longer
  reachable over the overlay, still answers on loopback. PASSED.
- Tests: `apps/desktop/test/devices-net.test.ts` (15) with a fake sidecar and a SOCKS stub, including a TLS request
  through `peerRequestOptions` (this one failed first: Node ignores createConnection when agent is false).
- Protocol s10 written up as built, plus the phone note (libtailscale later).

## Not done
- No auth key for the owner's Tailscale was found (searched ~ on the server, WSL home, Windows home config files for
  'tskey-'), so no live join on Tailscale's own control plane; the live proof is against Headscale.
- Android libtailscale: note only (s10).

## Merge notes
- This branch already contains devices-node and devices-headless-int (as of 22 Oct ~02:40); merge those first.
- Shared files touched with small hooks: `main/index.ts` (one `sidecar:` line + import), `preload/index.ts` (one
  line), `packages/core/src/ipc.ts` (types + one method), `shared/devices-channels.ts`, `renderer/bridge/remote.ts`
  and `mock-devices.ts`, `views/Devices.tsx` (one line), `headless/control.ts` (one allowlist entry),
  `headless/main.ts` (net command), `headless/devices.ts` (sidecar line), `scripts/build-headless.mjs`,
  `electron-builder.yml`.
- Binaries are not committed (`tools/agent-net/dist/` is ignored). Build with Go 1.25+ via `tools/agent-net/build.sh`
  before packaging; without them the app works and says the helper is missing when a network is picked.

## Release merge (22 Oct, about 04:45)
- Merged `devices` (A, B, C, device tools, firewall, url ranking) into devices-net. Overlay urls come FIRST in the
  advertised list while the overlay is up.
- Peer dialling wired: `socks.ts proxyFor(host)`: loopback never proxied; a set proxy (agent-node config --proxy,
  AGENT_NODE_PROXY) wins; else the overlay's SOCKS port for overlay hosts the OS cannot route. Used by pinnedFetch
  (replication), the uplink (A) and the headless pinned client (C). Test: real pinnedFetch to a pinned TLS peer
  through the overlay (fails without the wiring), wrong pin still refused.
- The overlay never writes the node's row or identity while Devices is off.
- Proven: typecheck, lint, full vitest 1270 passed; `bash scripts/devices-e2e-local.sh dist-headless/agent-node.mjs`
  7/7 with Network = None; binaries rebuilt on the server; tarball carries agent-net.
