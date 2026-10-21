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

## In flight / next
- Full vitest under flock, then tarball, then server deploy (step 5) and memory check (step 6).
- Lead's scope correction item 6 (server: own headless browser, relay through a linked device) comes after deploy.

## Merge notes
- Wire A's server into `headless/node-server.ts` `startNodeServer` (deps: runtime with `ipc` HandlerTable,
  config, cert, version). Its pass-table should read `secrets.get('passHashes')` (JSON) on the headless node.
- Wire B's `applyBundle` into `headless/bundle.ts`; secret names `devicePass` and `passHashes` need adding to
  `SecretName` if B types them.

## Last commit
(see git log)
