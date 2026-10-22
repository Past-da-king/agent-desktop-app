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

## SCOPE CORRECTION (Ayanda, 01:45), acknowledged 02:05, overrides everything above where they differ
1. Both apps stay standalone and work exactly as today. Linking is an optional extra (scan, or skip and nothing changes). No regressions.
2. Phone base = 0.13.0 (`~/phone-aos/app-thin`, targetSdk 28). No merging of the older server copies beyond backing up their uncommitted work.
3. Minimal changes. Desktop: only pair a phone/server by QR and serve them (minimal Settings > Devices). Phone: only "scan to link", then use that brain and its data in its existing native screens. D2 (WebView of the desktop UI) is DROPPED; A's /app/ web build and phone-width web UI are dropped.
4. Phone shows no project list/page. Only new visible thing: a delegated project agent shows like a helper with the project's icon and its live status line.
5. Origin awareness stays as plumbing (links/files to origin device, local images in chat).
6. Server: full freedom. One-command deploy, own headless browser, runs code and tools itself, relays blocked traffic through a linked device (PC or phone). Failover stays user-ranked. Assigned to C (relay after runtime + deploy).
- Contract: lease rows are entity `turn_lease` ('turn' is taken by transcript rows); B owns adding device, device_command, turn_lease to EntityName; A writes device rows via store.upsert.

## ADDITION (Ayanda, 01:50), acknowledged 02:10
1. Phone base is the THIN app (0.13.0, about 30 to 60 MB, runtimes downloaded on first use). Never ship the 360 MB bundled build.
2. Device tools are shared across linked devices: any agent on any brain can use another device's browser, notifications, files, approvals, shell. General layer: devices advertise tools, agents call with a device target or the router picks the best. Contract: protocol s11. Split: B = brain side (devices_list, device_tool, router, device arg on local tools); A = desktop serves its own tools to other brains; C = server serves its browser/shell and calls others; D = phone serves browser, notifications_read, files, notify/ask approval.
3. Origin awareness stays (replies, links, files to the sending device).

## Workstreams (each a project chat; branch off `devices`)
| # | Work | Branch / worktree | Status |
|---|---|---|---|
| A | Desktop node: server, TLS, pairing, RPC, /app web build + remote bridge, Settings > Devices UI | devices-node / ~/agent-desktop-wt/devices-node | chat pca89bc68131914ac8, running |
| B | Replication, bundle + secrets, origin awareness, device commands, turn leases, crash resume | devices-sync / ~/agent-desktop-wt/devices-sync | chat pc06e6196729724dbf, running |
| C | Headless node (plain Node 24) + deploy on server as a service | devices-headless / ~/agent-desktop-wt/devices-headless | chat pc79d2a9989e324333, running |
| D | Phone: linking on 0.13.0 (server feature/remote off 3811400, worktree ~/phone-aos/app-remote; backups backup/app-0.11.23-dirty, backup/app-thin-snapshot) | server ~/phone-aos | chat pc2f0194f996a947e0, running |
| E | agent-net tsnet sidecar | devices-net / ~/agent-desktop-wt/devices-net | chat pc0f6688d4a37f4884, running (Go builds on server) |

## Shared machine rules
- Locks: full vitest `flock /tmp/agent-vitest.lock`, Electron build `flock /tmp/agent-electron.lock`. Gradle only on the server.
- Never install over the running Agent app. Test desktop as win-unpacked with a separate userData and single-instance key.
- Check `free -m` before heavy steps; pause if available < 2 GB.

## Log
- 01:45 worktree + protocol written.
- 01:55 seam types (apps/desktop/src/main/devices/types.ts) + common brief committed (3df8a89). Chats A-D started; each keeps PROGRESS-<letter>.md in its worktree (D: in the server phone repo).

- 02:40 C done with steps 1-6: headless node built (devices-headless f9705c9, code de641d5), 9 headless tests + full suite 1120 pass. DEPLOYED on the server: ~/agent-node, data ~/.local/share/agent-node, 127.0.0.1:7787, reachable over the tailnet, keepalive = 2 crontab lines tagged "# agent-node keepalive", idle 71 MB. Real turn on the server via its ChatGPT plan (codex). Server Claude login EXPIRED (needs a person to run `claude` there; not blocking, ChatGPT plan works). Seams for merge: A replaces startNodeServer in src/headless/node-server.ts; B replaces applyBundle in src/headless/bundle.ts. Build: `node scripts/build-headless.mjs`; redeploy: scp tgz + `sh agent-node/install.sh --node ~/node-v24.15.0-linux-x64/bin/node`. C now on the server's own headless browser, then relay.
- 02:42 lead killed an orphaned 5 h vitest in ~/agent-desktop-wt/accounts (90% CPU, parent gone).

- 02:22 WSL restarted on its own (Wsl/Service/0x8007274c), likely Windows memory pressure (~1.6 GB free). Server node unaffected (it runs on the server). A on track: devices-node fb428a1, live proof copy C:\temp\devices-node-run (own userData, port 7797). WSL networking is mirrored (127.0.0.1 shared with Windows).

## Next for the lead
1. Watch RAM (Windows and WSL), answer helpers.
2. Merge A, B, C into `devices`; wire the seams (registerDevicesSync, headless startDevices).
3. Live test: test desktop (win-unpacked, own userData) + server headless node + scripted phone client: chat, bundle after scan, project turn, local image, open_url to origin, failover x2, crash resume.
4. Installer + APK + START-HERE.md into C:\Users\past9\Downloads\agent\. Start E when RAM allows.
