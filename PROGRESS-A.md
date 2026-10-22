# Workstream A: desktop node (progress)

Branch `devices-node`, worktree `~/agent-desktop-wt/devices-node`. Status: DONE (22 Oct 2026, about 02:40).

## Done and proven
- `main/devices/`: `cert.ts` (self-signed ECDSA P-256 X.509, own DER writer, no dependency), `identity.ts`
  (nodeId, meshId, key and cert in `<userData>/devices/`), `config.ts` (devices.enabled/port/listen/extraUrls in
  `<userData>/devices/config.json`, advertised urls), `passes.ts` (PassTable over the secrets module, sha256 only),
  `router.ts`, `ws.ts` (RFC 6455 server and client framing, no dependency), `server.ts` (DevicesHost: routes with
  :params and trailing *, auth none/device/node, Bearer or cookie, JSON caps, files with ranges, RPC upgrade),
  `pairing.ts` (offers 10 min, single use, 5 tries; agent://pair URI; short code), `facts.ts`, `registry.ts`
  (every ipcMain.handle kept by channel through `recordHandlers`), `rpc.ts` (sessions, allowlist), `origin.ts`
  (meta.origin), `service.ts` (wires it all; routes /v1/health, /v1/pair, /v1/devices, /v1/devices/:id/revoke,
  /v1/file, /app/*; Settings IPC; `getDevicesHost()` for workstream B).
- `shared/rpc-methods.ts` (method map, RPC_ALLOWED, RPC_EVENTS, $b64 codec), `shared/qr.ts` (QR encoder, no
  dependency; matrices equal python-qrcode's for versions 1, 9, 15 and all masks; the live QR decodes with OpenCV),
  `shared/devices-channels.ts`.
- Core: entity `device` (DeviceRow), `DevicesApi`, `DevicesStatus`, `PairingOfferInfo`, `AgentApi.devices`,
  `AgentApi.remote`. Preload, mock bridge (`bridge/mock-devices.ts`) updated.
- Renderer: `bridge/remote.ts` (AgentApi over /v1/rpc, reconnects, re-reads lists after a reconnect, look settings
  kept on the device), picked in `bridge/index.ts` when the page carries `<meta name="agent-remote">`.
  `views/Devices.tsx` + `styles/devices.css` (switch, Add a device with QR, short code, countdown, paired
  confirmation; device list with roles, brain order, last seen, this device, connected, Take out with a real
  dialog; addresses and extra address field; Windows firewall hint). Remote degrade: Settings shows Devices and
  Look only; no window controls, no call button, no shortcut hint on touch, no browser demo page.
- Hooks: `main/index.ts` (ipcMain through recordHandlers, broadcast to devices, service start, AGENT_USER_DATA
  for a test copy), `main/ipc.ts` (chat.send passes the origin), `runtime/runner.ts` (send(..., origin) puts
  meta.origin on the user row).
- Tests: `test/devices-unit.test.ts` (23), `test/devices-node.test.ts` (7, real server on 127.0.0.1 and ::1, real
  registerIpc, pinned client). Typecheck and lint clean. Full suite: 1141 passed; one unhandled rejection from
  `helpers.test.ts` "runs two helpers at the same time" that also happens on the base commit 3df8a89 (pre-existing).
- Live proof on Windows: Electron 44.9.1 running this build from `C:\temp\devices-node-run` with
  AGENT_USER_DATA=`C:\temp\devices-node-run\userdata`, port 7797, DevTools 9341 (`scripts/devices-cdp.mjs`).
  Devices switched on through the UI; Add a device QR decoded by OpenCV; `scripts/devices-client.mjs` paired from
  WSL with the fingerprint pinned, called RPC, heard the data event, uploaded and fetched a file; revoke through the
  real dialog closed its line (4003) and its pass got 401. Screenshots in `C:\temp\devices-node-run\shots` and
  `C:\temp\shots-devices` (mock and remote at 390, 412, 1280).

## Not done / limits
- Inbound from other LAN devices on Windows needs the person to allow the firewall prompt (Windows added Block
  rules for the test binary when the prompt went unanswered). WSL (mirrored networking) cannot reach the host's LAN
  or VPN addresses; tested over 127.0.0.1 from WSL and ::1 / the VPN IPv6 address from Windows.
- Headless build: serve `out/renderer` as `rendererDir` (DevicesService takes it as a dependency).
- Live calls over the wire (callAudio streaming) are not offered remotely; the Talk button hides.

## Last commit
- see `git log -1` on devices-node
