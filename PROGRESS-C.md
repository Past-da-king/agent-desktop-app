# PROGRESS-C: headless node + server deploy

Branch `devices-headless` (off `devices`), worktree `~/agent-desktop-wt/devices-headless`. Owner of this file: workstream C.

## Done
- `apps/desktop/src/headless/runtime.ts`: the runtime composed without Electron (Store, settings, secrets, accounts,
  runner, helpers, routines/scheduler, memory + chat index + tidy, connected/learned apps, projects tools). Every ipc
  handler is collected in a `HandlerTable` (`runtime.ipc`) so the node server can serve `/v1/rpc` with the exact same
  handlers the window uses. Browser tools stay listed but say "Not available on this device". open_url / notify go
  through `runtime.actions` (default: log, "no screen"); the node server replaces them with device commands.
- `file-cipher.ts`: safeStorage stand-in, AES-256-GCM with a random 32-byte key in a 0600 file.
- `node-config.ts`: node.json (id, name, meshId, listen 127.0.0.1, port 7787, publicUrls, brains, deviceId) and the
  self-signed ECDSA P-256 cert via openssl (fp = base64url sha256 DER).
- `pinned.ts`: HTTPS client pinned by fp; the TLS handshake is checked before any byte of the request is written.
- `pair.ts`: `agent-node pair 'agent://pair?...'` and `--url --code`; POST /v1/pair with wantRoles brain+hands,
  pass to secrets (`devicePass`), brains to node.json, then GET /v1/bundle and `applyBundle`.
- `bundle.ts`: SEAM, minimal `applyBundle` (settings minus device-local ones, accounts, profiles, learned apps,
  secrets incl. `passHashes`). Replace with B's at merge.
- `node-server.ts`: SEAM, `startNodeServer(deps)`. Basic HTTPS server: real cert/port/listen, `/v1/health` per
  protocol, a route table with the `DevicesHost` shape; everything else 404. Replace the body with A's server at merge.
- `main.ts`: CLI `start [--daemon] | stop | status | pair | devices | config | version`; pid file, SIGTERM/SIGINT
  waits up to 20 s for a running turn then exits (an unfinished turn is marked interrupted and resumed on next start).
- `electron-shim.ts`: aliased for 'electron' in the bundle (settings.ts -> hotkeys.ts -> hotkey.ts imports it).
- `cli-host.ts`: 3 lines, `AGENT_CLAUDE_PATH` / `AGENT_CODEX_PATH` override the engine binary (the tarball leaves
  out the 700 MB of bundled engines and uses the machine's installed claude/codex).
- `scripts/build-headless.mjs`: esbuild -> `dist-headless/agent-node.mjs` (fails if anything but node: builtins and the
  two SDKs is external, or real electron is bundled); tarball `dist-headless/agent-node-<v>-linux.tgz` with
  README, install.sh, package.json, node_modules (SDKs and peers, no optional engines).
- `pack/install.sh`: no root; ~/agent-node + ~/.local/share/agent-node; systemd --user unit when lingering is on,
  else crontab `@reboot` + `*/5` keepalive lines tagged `# agent-node keepalive` (backs up crontab first, leaves
  other lines alone); `--uninstall`.
- `apps/desktop/test/headless.test.ts` (8 tests): cipher; a full chat turn with memory_save on a fake OpenAI server
  plus ipc table; node server health pinned + wrong pin refused; pairing by link (pass, bundle, no secrets in json),
  by short code (TOFU), wrong cert sends nothing; arg/link parsing; bundle builds and `status` exits 0 under plain
  Node from a dir with no node_modules.

- CLI also has `account list|add claude|add codex|add api --provider P < keyfile|remove` (keys only on stdin) and
  `ask "text"` (one turn in-process, refuses while the service runs on the same data dir).
- `scripts/headless/install-test.sh <tgz>`: sandboxed install test (temp HOME, fake crontab, no systemd): install,
  keepalive restarts after kill -9, reinstall over a running copy, uninstall; existing crontab lines kept.

## Proven (22 Oct, 02:10)
- `npx vitest run apps/desktop/test/headless.test.ts`: 9 passed. Full suite under flock: 1120 passed, 9 skipped.
- `npm run typecheck`, `node scripts/lint-checks.mjs`: clean.
- Server (user home only, no sudo): `install.sh --node ~/node-v24.15.0-linux-x64/bin/node`; crontab 42 -> 44 lines
  (two `# agent-node keepalive` lines; backup in ~/agent-node/backups). Linger is off, so crontab keepalive.
  `curl -sk https://127.0.0.1:7787/v1/health` on the server and from WSL over the tailnet address: ready true.
  RSS idle 71 MB; server free -m: about 8 GB available.
- Real turn on the server: `agent-node account add codex` + `agent-node ask` answered "headless node ok" in 6 s
  through the server's ChatGPT plan. The Claude engine runs too, but the server's own Claude login has expired
  (`claude auth status`: loggedIn false), so Claude-plan turns there need someone to run `claude` and sign in.
- The service on the server runs with a ChatGPT plan account (so it is ready before pairing); pairing replaces
  accounts with the desktop's.

## Server browser (scope item 6, part 1) DONE (22 Oct, 02:30)
- `headless/browser.ts` HeadlessBrowser: BrowserDriver + BrowserProDriver over CDP on the machine's Chromium
  (findChromium: AGENT_CHROMIUM_PATH, Playwright cache, chromium/google-chrome on PATH). Reuses the desktop page
  scripts (outline, read, type, snapshot, resolve, evalWrapper) and the trusted-input `Cdp` class. One tab per agent
  (browserOwner), max 6. Starts on first use (sandbox, then --no-sandbox fallback), closes after 10 min idle and on
  stop; one Chromium profile folder per partition. Network devtools tools (browser_network etc.) are not wired
  (devtoolsOf needs Electron webContents): they answer as having no page.
- `test/headless-browser.test.ts` (3, real Chromium, skipped where none): open + outline, trusted type + click +
  eval, snapshot, screenshot; separate tabs per agent; close and restart. Saw it fail with typing broken.
- Server: redeployed; log "Browser available 1"; a real turn (`agent-node ask`, ChatGPT plan) opened example.com
  in the server's own Chromium and answered "Example Domain" in 10 s. Chromium closed after the turn.
- Full suite: 1123 passed, 9 skipped. One intermittent unhandled rejection comes from the existing
  helpers.test.ts "runs two helpers at the same time" (teardown closes the store while a helper still writes its
  meta); not in this lane, seen on and off, left as is.

## Integration with A (branch devices-headless-int, 22 Oct 03:00)
- devices-headless + merge of devices-node (A, fb428a1), no conflicts. B NOT merged here: A and B conflict with each
  other (two DeviceRow types, db.ts, runner.ts, ipc.ts, origin.ts...), which is the lead's merge.
- The headless node runs A's `DevicesService` as kind 'server' (A's service got an optional `kind` /
  `canOpenLinks` / `canReceiveFiles`, defaults unchanged). My basic server (node-server.ts) and the openssl cert are
  gone; identity and cert are A's (`<data>/devices/identity.json`, `node-key.pem`, `node-cert.pem`). The runtime's
  handlers are recorded in a HandlerRegistry, so A's /v1/rpc serves the headless runtime. Pairing joins the mesh
  (joinMesh). Pass hashes go to A's SecretPassTable.
- Local control socket `<data>/control.sock` (0600) for the CLI: `offer` (QR in half blocks + link + short code),
  `devices`, `roles`, `move`, `revoke`; `config --url` adds an advertised address.
- PROVEN: headless.test.ts 10 pass: a headless node pairs with another headless node through A's server and drives
  a chat turn over /v1/rpc (origin recorded); the CLI e2e test (start daemon, offer, pair with the printed link,
  devices, revoke). Mutation: without the handler registry the RPC test fails "not available on this device".
  Full suite: 1153 passed (the only error is the known helpers.test.ts flake). `scripts/headless/qr-check.sh`
  decodes the terminal QR with OpenCV: matches the link.
- SERVER redeployed (5fb52e1): ready, crontab 44 lines. Cross-machine: a temp node in WSL paired with the server by
  `agent-node pair --url https://<tailnet address>:7787 --code <code from 'agent-node offer' on the server>`; the
  server listed it as brain+hands; then revoked it (row stays, revoked). Bundle answers 404 until B is merged.

## Relay + SOCKS5 (22 Oct 02:50 UTC+2 ~ 03:50)
- `main/devices/relay.ts`: `relay.fetch` RPC on every node = the app's own web_fetch (no private nets, no loopback,
  text only, capped), only for paired brain/hands devices (screens refused). Registered by the headless node;
  the DESKTOP needs one line where index.ts starts DevicesService:
  `registerRelay(devices.host(), { store, rolesOf: rolesFromStore(store) })`.
- `headless/rpc-client.ts` (pinned WS RPC client) and tool `web_fetch_via_device` (main + helpers on headless).
- `main/devices/socks.ts` + `headless/pinned.ts`: node-to-node connections through SOCKS5 when set
  (`agent-node config --proxy socks5://host:port`, or AGENT_NODE_PROXY). FINDING: the server's tailscaled runs in
  userspace mode, so the server reaches other tailnet devices ONLY through its local SOCKS5 port (direct = no route,
  via socks5 = 200). The server node is configured with its local proxy. B's replication from the server
  (devices/pinned-fetch.ts) needs the same proxy, or the desktop must be the side that connects.
- PROVEN: headless.test.ts 12 pass (relay through a paired node in an agent turn; a screen is refused; SOCKS5
  pin end to end + proxy down answers plainly). LIVE across machines (`scripts/headless/relay-live.sh <ssh host>
  socks5://localhost:1055`): a temp node in WSL as "home computer", a temp dir on the server paired to it through
  the proxy, and the server's agent (ChatGPT plan) answered with example.com's first sentence "Fetched through"
  the WSL node; the WSL node logged `Relay fetch {host: example.com}`.

## In flight / next
- After the lead merges A+B: wire B (registerDevicesSync with the headless store/secrets/profiles/learned/passes,
  TurnLeases, BundleKeeper; pair -> joinFrom), drop headless/bundle.ts stub, redeploy, prove bundle + replication
  between the desktop and the server.
- Relay through a linked device (scope item 6, part 2).

## Merge notes
- Wire A's server into `headless/node-server.ts` `startNodeServer` (deps: runtime with `ipc` HandlerTable,
  config, cert, version). Its pass-table should read `secrets.get('passHashes')` (JSON) on the headless node.
- Wire B's `applyBundle` into `headless/bundle.ts`; secret names `devicePass` and `passHashes` need adding to
  `SecretName` if B types them.

## Last commit
(see git log)
