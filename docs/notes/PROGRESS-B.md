# PROGRESS B: replication, bundle, origin, device commands, turn leases, crash resume

Branch `devices-sync` (off `devices`), worktree `~/agent-desktop-wt/devices-sync`. Contract: `docs/devices-protocol.md`
s4-s8 (updated in this branch where the build had to decide something; see the "As built" paragraphs there).

## Done (all proven by tests, see Proof)
- Synced entities `device`, `device_command`, `turn_lease` (core ipc.ts types, sync/change.ts, db.ts, renderer
  lists). `turn` was already the model transcript, so the s8 lease row is `turn_lease`.
- db.ts change log (`change_log`: seq, entity, cid, via), backfilled on first open. `applyRemote(changes, via)`,
  `changesAfter(seq, limit, skipVia)`, `logSeq()`, `localValue/setLocalValue`. The single sync service path is
  unchanged.
- devices/replicate.ts: `registerSyncRoutes` (POST /v1/sync/push, GET /v1/sync/pull long-poll, auth node, never
  hands a change back to where it came from) and `Replicator` (a link per brain/hands peer from device rows, per-peer
  cursors, nudged by local writes, tries every address, backoff).
- devices/pinned-fetch.ts: https pinned to base64url(sha256(cert DER)); nothing (not even headers) is written before
  the pin is checked.
- devices/bundle.ts: `BundleKeeper` (build, check, apply), GET /v1/bundle (secrets only for role brain),
  `devices.bundle` { version } to connected brains, version on every pull answer, `pullBundle`, join with force.
  ProfileStore/LearnedStore/ConnectedAppsFile gained `replaceAll`/`allRules`/`replaceRules`/`setUserId`.
- devices/origin.ts + prompt line (`deviceLine`, section THE DEVICE THE USER IS ON) + runner stores meta.origin on
  typed messages (`runner.send(text, files, chat, origin?)`: RPC passes the phone's origin).
- devices/commands.ts: `DeviceCommands` (row first, emit to the target's connections, `device.ack` RPC, queue while
  offline, deliver on connect, expire after 10 min with one note to the chat). tools/devices.ts: `open_url`,
  `send_file` (main agent; act locally when the message came from this computer or Devices is off).
- runtime/turns.ts: `TurnLeases` (begin/end + 10 s heartbeat, recover on start, failover claim with injectable health
  and ranking, max 3 attempts then a visible note, a lost lease stops our run). Hooks: runner.begin/resumeTurn,
  helpers pump/finish (jobs resume through helpers.push). Wired in index.ts, so it works with Devices off.
- s11 shared device tools, brain side (devices/device-tools.ts): `DeviceToolHub` (tools on device rows from hello,
  `call` with forgiving match or "best", router origin > preferred > priority with phones last for heavy work,
  `device.result` RPC, offline queue, late result to chat, images to files), `DeviceToolRunner` (a node runs tools
  other brains ask of it via synced rows, refuses groups it does not share), agent tools `devices_list` and
  `device_tool`, `withDeviceArg` (optional `device` on browser tools, notify_user, ask_user, request_approval,
  send_file, open_url; notify defaults to the origin; a blocked local browser call names the linked browsers).
  Settings `devicesPreferred`, `devicesShareGroups`. Tests: apps/desktop/test/devices-tools.test.ts (11).
- devices/sync.ts: `registerDevicesSync(host, deps)` and `devicesState` (the one place the app asks "is Devices on").

## Proof (last full run: 1152 passed, 9 skipped, exit 0)
- `npx vitest run apps/desktop/test/devices-replicate.test.ts apps/desktop/test/devices-bundle.test.ts
  apps/desktop/test/devices-commands.test.ts apps/desktop/test/turn-leases.test.ts apps/desktop/test/devices-tls.test.ts
  apps/desktop/test/devices-sync.test.ts`
- Full suite under `flock /tmp/agent-vitest.lock npx vitest run`, `npm run typecheck`, `node scripts/lint-checks.mjs`.

## Merge notes for the lead
- Call site (in A's server start, when Devices is switched on):
  `devicesState.sync = registerDevicesSync(host, { store, pass: () => <this node's own pass>, bundle: { settings,
  secrets, profiles: apps.profiles, learned, connected: <the ConnectedAppsFile>, passes: <PassTable>, projects: () =>
  store.list('project') }, leases: <index.ts leases>, noteBack: (chat, text) => runner.deliver(text, chat) })`;
  on switch-off `devicesState.sync?.stop(); devicesState.sync = null`. After pairing as a node:
  `devicesState.sync.joinFrom(brainUrl, brainFp)`.
- registerDevicesSync deps for s11: `localTools: () => <the helpers' worker toolset>`, `shareGroups: () =>
  settings.get().devicesShareGroups`, `preferred: () => settings.get().devicesPreferred`, optional `context` for
  ask_user on this node. A's hello cleaner must keep `device.tools`.
- RPC chat.send: call `runner.send(text, attachments, chat, origin)` with the caller's MessageOrigin.
- /v1/file must also allow paths named in `device_command` rows whose target is the caller.
- The first node of a mesh needs a pass of its own (to call peers); without one its replicator idles, and peers that
  reach it still sync both ways.
