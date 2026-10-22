# Workstream A: desktop node (progress)

Branch `devices-node`, worktree `~/agent-desktop-wt/devices-node`. Status: DONE including s11 and the firewall step
(22 Oct 2026, about 02:55). Scope per Ayanda 01:45: desktop stays standalone, Devices off by default, minimal UI.

## Done and proven
- Node: identity and self-signed cert (lazy: made only when Devices is switched on or a part asks for the host),
  HTTPS server, pairing (QR + short code, 10 min, single use, 5 tries), pass table in the secrets store,
  /v1/health, /v1/pair, /v1/devices, /v1/devices/:id/revoke, /v1/file, /v1/rpc with the allowlist
  (`shared/rpc-methods.ts`: chat.send with meta.origin, data.list/get/upsert/remove incl. projects for icons,
  memory.*, tasks via data.*, chat events). Dual-stack listen.
- Devices off = as before: no identity files, no device row, no origin, nothing listens or links out (test
  "the desktop node with Devices off").
- s11 (`devices/device-tools.ts`, `devices/uplink.ts`): hello `tools` stored on the device row; RPC device.result
  routed to `DevicesHost.onDeviceResult` listeners; this node serves its own tools (browser_*, notify_user,
  ask_user/request_approval shown in this app via `Runner.deviceToolContext`, files_*, file_send, file_receive,
  shell_run) per share group (browser/files/notifications/approval on, shell off); it links OUT to the answering
  brain with its own pass and serves commands there. Proven with two real nodes in `test/devices-tools.test.ts`.
- Windows Firewall (`devices/firewall.ts`): netsh check (no elevation), state blocked/missing/allowed, ONE elevated
  command (Start-Process -Verb RunAs, script base64) to allow; tested without running it. Live: the test copy found
  the real Block rules and showed "Allow connections" (shots `C:\temp\shots-devices\live-firewall-step-*.png`).
  No UAC prompt was triggered.
- Settings > Devices (minimal): switch, Add a device (QR, short code, countdown), list with roles chips, brain order,
  Take out with a real dialog, Allow connections (Windows, when needed), share switches. Address list and extra
  address field removed from the UI.
- Kept from before (no runtime cost with Devices off; no more work on it): web UI at /app/ with the remote bridge.
- Tests: devices-unit (23), devices-node (7), devices-tools (12). Typecheck and lint clean.

## Not done / limits
- Test Block rules Windows made for `C:\temp\devices-node-run\electron\electron.exe` (two inbound rules named
  "Electron", TCP and UDP, Private+Public) need elevation to delete; left in place.
- `helpers.test.ts` has a pre-existing unhandled rejection (also on base 3df8a89).
- Entity names: B adds device, device_command, turn_lease; A's 'device' lines differ slightly (typed DeviceRow);
  C resolves at merge.

## Last commit
- see `git log -1` on devices-node
