# PROGRESS: One agent across all devices

Lead: project chat in "Agent Desktop App" (Hina). Started 22 Oct 2026 01:40 SAST. Deadline: deliverable ~07:00 Thu 22 Oct, keep improving until Fri 23 Oct 05:00.
Branch `devices` off `design` 4d5bcff, worktree `~/agent-desktop-wt/devices`. Contract: `docs/devices-protocol.md`.

## Facts found (01:30-01:45)
- Tailnet exists already (WSL, Windows PC, phone, server, a second Windows PC are all on it). Server runs tailscaled in userspace mode (no root) as user impetix. So addresses already reach each other; the embedded sidecar is optional (protocol section 10).
- Go: not installed in WSL or on the server. Server: Node 18 system, Node 24 in ~/node-v24.15.0-linux-x64, 16 GB RAM, 8 cores. Old agents on server (~/impetix-agent, ~/aos-server, cron keepalive): leave alone, sit beside.
- WSL: 8 GB RAM, 6 cores. Phone: server repo ~/phone-aos/app 0.11.23 (dirty), ~/phone-aos/app-handoff 0.12.12, PC ~/phone-aos/app-thin 0.13.0 (targetSdk 28).
- Renderer already swaps its bridge (`renderer/bridge/index.ts`: window.agent or mock) and has some 720px CSS, so the phone can use the node's web UI in a WebView.

## Decisions
- D1 Transport: HTTPS with per-node self-signed cert pinned by fingerprint from the QR, bearer device pass. (protocol s2)
- D2 Phone Remote mode = native shell + the node's web UI in a pinned WebView, not a second native UI. (s9)
- D3 Brains replicate rows with the existing push/pull sync protocol, multi-master, relayed. (s7)
- D4 Crash resume and failover through synced `turn` lease rows. (s8)
- D5 Networking pluggable; LAN/direct first, tsnet sidecar optional. (s10)

## Workstreams (each a project chat; branch off `devices`)
| # | Work | Branch / worktree | Status |
|---|---|---|---|
| A | Desktop node: server, TLS, pairing, RPC, /app web build + remote bridge, Settings > Devices UI | devices-node / ~/agent-desktop-wt/devices-node | chat pca89bc68131914ac8, running |
| B | Replication, bundle + secrets, origin awareness, device commands, turn leases, crash resume | devices-sync / ~/agent-desktop-wt/devices-sync | chat pc06e6196729724dbf, running |
| C | Headless node (plain Node 24) + deploy on server as a service | devices-headless / ~/agent-desktop-wt/devices-headless | chat pc79d2a9989e324333, running |
| D | Phone: merge 0.13.0 into server repo, Remote mode | server ~/phone-aos | chat pc2f0194f996a947e0, running |
| E | agent-net tsnet sidecar | later | held: Windows had 1.6 GB free at 01:55 |

## Shared machine rules
- Locks: full vitest `flock /tmp/agent-vitest.lock`, Electron build `flock /tmp/agent-electron.lock`. Gradle only on the server.
- Never install over the running Agent app. Test desktop as win-unpacked with a separate userData and single-instance key.
- Check `free -m` before heavy steps; pause if available < 2 GB.

## Log
- 01:45 worktree + protocol written.
- 01:55 seam types (apps/desktop/src/main/devices/types.ts) + common brief committed (3df8a89). Chats A-D started; each keeps PROGRESS-<letter>.md in its worktree (D: in the server phone repo).

## Next for the lead
1. Watch RAM (Windows and WSL), answer helpers.
2. Merge A, B, C into `devices`; wire the seams (registerDevicesSync, headless startDevices).
3. Live test: test desktop (win-unpacked, own userData) + server headless node + scripted phone client: chat, bundle after scan, project turn, local image, open_url to origin, failover x2, crash resume.
4. Installer + APK + START-HERE.md into C:\Users\you\Downloads\agent\. Start E when RAM allows.
