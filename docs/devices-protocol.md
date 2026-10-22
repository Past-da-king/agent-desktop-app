# Devices: one agent across all of a person's devices

Status: v1 design, 22 Oct 2026. This is the contract every part builds to (desktop node, headless node, phone app).
If you must change it, change this file in the same commit and say why.

General rule: nothing here assumes any particular person, host, network or device mix. Any number of phones,
tablets, desktops (Windows, macOS, Linux) and headless servers. Roles are set by the user. No hostnames, IPs, tailnet
names or keys in source or defaults.

## 1. Words

- **Node**: any running copy of the app that serves the Devices API (the desktop app with Devices switched on, or the
  headless build). A node can be a **brain** (runs turns: has an AI plan or key) and/or **hands** (runs device tools).
- **Screen**: a device that only shows the data and sends turns (a phone in Remote mode). Holds no AI keys, no
  project folders. A screen is a client, not a node.
- **Mesh**: the set of devices one person has paired. Identified by `meshId` (random, made by the first node).
- **Device pass**: a 256-bit random bearer secret issued to one paired device. Nodes store only `sha256(pass)`.
  Revoking a device deletes its pass hash everywhere.

## 2. Transport and trust

- HTTPS (TLS 1.2+) on one port, default **7787** (setting `devices.port`). Each node makes its own self-signed
  ECDSA P-256 certificate on first start (stored in `<userData>/devices/`). Clients pin it by
  `fp = base64url(sha256(cert DER))`. No CA, no plain HTTP for anything authenticated.
- Listen address: setting `devices.listen`, default `0.0.0.0` once the user switches Devices on; off by default.
  The headless node defaults to `127.0.0.1` plus whatever the user configures (it may sit behind a mesh VPN that
  forwards to loopback).
- Reachability is pluggable and never required to be any one product: plain LAN, any directly reachable address the
  user types ("public address" setting, e.g. a VPS name), or an overlay network (an embedded Tailscale/Headscale
  sidecar, see section 10). A node advertises every address it believes reachable: its non-loopback interface
  addresses plus the user's extra addresses, each as `https://<addr>:<port>`.
- Auth: `Authorization: Bearer <pass>` or cookie `agent_pass=<pass>` (for the web UI in a WebView). Every
  authenticated request is bound to the `deviceId` that owns the pass. A WebView or browser gets the cookie by
  opening `GET /app/?k=<pass>` once: the node answers `302 Location: /app/` with
  `Set-Cookie: agent_pass=<pass>; Path=/; Secure; HttpOnly; SameSite=Strict` (so page script never sees the pass).
- Listen `0.0.0.0` means every address: the desktop node listens dual-stack (`::`) and falls back to IPv4 only
  (then it stops advertising IPv6 addresses) where the system has no IPv6.
- Windows: the first time the node listens, Windows Firewall asks whether the app may use the network. Unanswered
  or refused, Windows adds a Block rule and other devices on the LAN cannot connect (loopback still works).
  A per-user installer cannot add an Allow rule without admin rights, so Settings > Devices shows "Allow
  connections" when the check (`netsh advfirewall firewall show rule name=all dir=in verbose`, no elevation) finds
  a Block rule for the app or no Allow rule for the app or the port. It runs ONE elevated PowerShell (one UAC
  prompt) that removes the app's inbound rules and adds "Agent devices" (program) and "Agent devices (port N)"
  (TCP), profiles private and domain (`main/devices/firewall.ts`).

## 3. Pairing (QR + short code)

On a node, Settings > Devices > "Add a device" creates a **pairing offer** valid 10 minutes, single use, 5 wrong
tries max:

```
agent://pair?v=1&mesh=<meshId>&node=<nodeId>&name=<url-encoded node name>&u=<url1>,<url2>,...&fp=<fp>&c=<secret>
```

- `c` is 128-bit random, base64url. Shown as a QR code.
- The **short code** is 8 characters from an unambiguous alphabet (no 0/O/1/I), shown as `ABCD-EFGH`. Typing it
  plus any node address works the same as the QR; with the short code the client accepts the certificate on first
  use and shows its fingerprint words.

`POST /v1/pair` (no auth) body:

```json
{ "code": "<c or short code>", "device": DeviceFacts, "wantRoles": ["screen"] }
```

`DeviceFacts`:

```json
{ "name": "Pixel 8", "kind": "phone|tablet|desktop|server", "platform": "android|ios|windows|macos|linux",
  "appVersion": "0.14.0", "screen": { "width": 412, "height": 915 }, "canOpenLinks": true,
  "canReceiveFiles": true, "fingerprint": "<fp of its own cert, nodes only, else empty>",
  "urls": ["https://..."] }
```

Answer `200`:

```json
{ "deviceId": "dev_...", "pass": "<pass>", "meshId": "...", "node": { "id": "...", "name": "..." },
  "brains": [ BrainRef ] }
```

`BrainRef = { "id", "name", "urls": [...], "fp", "priority": 0 }` (lower priority number = tried first).

After pairing, a **node** (wantRoles includes `brain` or `hands`) immediately pulls the bundle (section 6) and starts
replication (section 7). A **screen** only needs the pass and the brain list.

Headless pairing: `agent-node pair '<agent://pair?...>'` or `agent-node pair --url https://host:7787 --code ABCD-EFGH`.

## 4. Device registry (synced)

Entity `device` rows (they sync like every other row, HLC last-writer-wins):

```json
{ "id": "dev_...", "name": "...", "kind": "phone", "platform": "android", "roles": ["screen"],
  "priority": 0, "urls": [], "fp": "", "facts": DeviceFacts, "pairedAt": 0, "lastSeen": 0, "revoked": false }
```

- Brains are ranked by `priority`; the user reorders them in Settings > Devices (drag or up/down). Any device's
  roles can be changed there. Revoking sets `revoked: true`, removes the pass hash, closes its connections.
- Pass hashes are NOT in rows. They travel in the brain-only part of the bundle (section 6).

## 5. API (all under the node's https origin)

| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/v1/health` | none | `{ id, name, version, roles, ready, busy, meshId }`. `ready` = can run turns now. |
| POST | `/v1/pair` | none | section 3 |
| GET | `/v1/rpc` (WebSocket upgrade) | pass | the app contract over the wire, section 5.1 |
| GET | `/app/` | pass (cookie) | the web build of the renderer, using the remote bridge. It is the app's own renderer build (`out/renderer`), with `<meta name="agent-remote" content="1">` added to index.html at serve time; `?k=<pass>` sets the cookie (s2). Without a valid cookie: a short "not linked yet" page. |
| GET | `/v1/file?path=<abs>` | pass | a local file named in a chat (images in cards, attachments). Only paths that appear in a chat row, the user's attachments folder, or project folders. `Content-Type` by extension. Range requests for big files. |
| GET | `/v1/bundle` | pass | section 6 |
| POST | `/v1/sync/push` | pass (node) | same body/answer as `packages/core/src/sync/client.ts` |
| GET | `/v1/sync/pull?since=&wait=` | pass (node) | same as above (long-poll up to 55 s); `cursor=` is accepted for `since=`; the answer also carries `bundle` (the node's bundle version, section 6) |
| GET | `/v1/devices` | pass | the device rows plus which brain is answering |
| POST | `/v1/devices/:id/revoke` | pass (node) | revoke |

### 5.1 RPC over WebSocket

Client sends first `{"type":"hello","device":DeviceFacts}` (and again whenever facts change, e.g. rotation).
Then:

- call: `{"type":"call","id":"<n>","method":"chat.send","args":[...]}`
- answer: `{"type":"result","id":"<n>","ok":true,"value":...}` or `{"type":"result","id":"<n>","ok":false,"error":"..."}`
- server event: `{"type":"event","name":"<EVENTS.* channel name>","payload":...}`

`method` names mirror the `AgentApi` contract in `packages/core/src/ipc.ts` (dotted path of the method, e.g.
`memory.search`, `chat.send`, `data.list`). The node serves an ALLOWLIST: everything a person uses day to day
(chats, memory, tasks, goals, routines, projects as read + open, profiles read, apps status read, learned apps read,
settings read). Never over the wire: raw secrets reads, window controls, hotkeys, dictation hardware, file pickers,
shell settings changes. A method not on the list answers `ok:false, error:"not available on this device"`.

The list itself is code: `apps/desktop/src/shared/rpc-methods.ts` (`RPC_ALLOWED`, and `RPC_EVENTS` for the
events a device hears). Methods another part adds with `DevicesHost.addRpc` are answered first, by name. Details:

- The first frame must be `hello` within 15 s, or the node closes with 4000; a bad hello closes with 4002; a
  revoked device's connections close with 4003. Calls before hello answer `ok:false`.
- Bytes (`Uint8Array`, e.g. `files.savePasted`, `voice.noteAudio`) travel as `{"$b64":"<base64>"}` in args and
  values. Everything else is plain JSON.
- `data.upsert` and `data.remove` on entity `device` are refused over the wire (roles and order change only
  through the node's own Settings).
- `devices.status` and `devices.list` are on the list; `status.viewer` is the calling device's id.
- A wire call reaches the main-process handler with a stand-in event `{ sender: null, wire: { deviceId, origin } }`
  (`main/devices/registry.ts` `wireOf`), so any handler can tell which device called.

### 5.2 Device commands (tools that act on a device)

`{"type":"event","name":"device.command","payload":{"id":"cmd_...","kind":"open_url|send_file|notify|show_image","url"?,"path"?,"name"?,"title"?,"body"?}}`
sent ONLY to the connection(s) of the target device. The client acks with call `device.ack(id, ok, note)`.
If the target is not connected, the command waits in a `device_command` row (synced) and is delivered when it
connects, or expires after 10 minutes with a note back to the agent.
`send_file` gives `url: /v1/file?path=...` for the client to download with its pass.

The row (entity `device_command`, synced): `{ id, target, kind, url?, path?, name?, title?, body?, status, note, chat,
brainId, expiresAt, updatedAt }`, `status` = `queued` (target offline) | `sent` (delivered, no ack yet) | `done` |
`failed` (the ack said so) | `expired`. Any brain the target is connected to delivers a `queued` row (checked every
3 s); only the brain that made it (`brainId`) writes the expiry note into `chat`. Only the target device may ack.
`/v1/file` must also serve a path named in a `device_command` row whose `target` is the caller.

## 6. State bundle

`GET /v1/bundle` returns what a new device needs that is not in synced rows:

```json
{ "settings": { ...non-secret settings }, "profiles": [...], "projects": [...], "learnedApps": [...],
  "connectedApps": { ...per-account rules, no keys }, "accounts": [ AiAccount without keys ],
  "secrets": { ... }  // ONLY for devices whose roles include "brain"; omitted for screens
}
```

`secrets` carries what a brain needs to run turns: AI account keys, Composio key, and the mesh pass-hash table
`{ deviceId: sha256(pass) }`. It only ever travels inside the pinned TLS connection, and the receiver stores it in
its own secrets store (Electron safeStorage, or a 0600 key file on the headless node). Bundle changes are pushed to
connected brains as event `devices.bundle` so a key added on one brain reaches the others.

As built (apps/desktop/src/main/devices/bundle.ts):
- The bundle also has `version` and `changedAt`. `secrets` = `{ keys: { "apiKey-<account>": key }, composioKey?,
  composioUserId?, geminiKey?, passes }`. `settings` is only the person's settings (names, theme, AI picks...), never
  per-machine ones (hotkeys, folders, start-up, sync account). `projects` are the project rows (they also replicate).
- The `devices.bundle` event payload is `{ version }` only, never the bundle: the brain reads `GET /v1/bundle` again.
  Brains that are not on RPC to each other see the version on every replication pull answer (`bundle` field) and
  read the bundle when it changes, and on the first pull after connecting.
- The newest `changedAt` wins; the receiver keeps the sender's `changedAt`, so two brains never bounce a bundle. A
  fresh install starts at `changedAt` 0. Right after pairing a node takes the brain's bundle regardless (join).
- An account missing from a newer bundle takes its key with it on the receiver.

## 7. Replication between brains

All brains hold the full row set. Each node keeps a change log (every applied row change gets a local sequence
number, with the originating device). A node replicates with every other reachable brain using the existing
push/pull protocol: it pushes changes the peer has not seen (per-peer cursor) and pulls the peer's log from its
cursor. Applying a change is idempotent (HLC). Changes are relayed, so A <-> B <-> C converges even if A cannot
reach C. Replication is initiated by whichever side can reach the other, so a node behind a firewall still syncs.

As built (db.ts `change_log`, devices/replicate.ts): the log holds one entry per row (its newest change) with a local
`seq` and `via` (the node that handed it over, '' for local writes and the sync service). A pull or push never hands
a change back to the node it came from (`via`). Per-peer cursors (`peer_push:<id>`, `peer_pull:<id>`) live in the
local kv. A peer whose cursor is ahead of our log (our database was reset) is started again from 0. A link pushes
first, then long-polls; a local write cuts the long poll short so it goes out within about 200 ms. The existing
single sync service (`syncUrl`) is unchanged and runs beside it; what it brings in is relayed to peers too.

## 8. Turns, origin, failover, crash resume

- **Origin**: every user message row's `meta.origin = { deviceId, name, kind, platform, screenWidth, canOpenLinks,
  canReceiveFiles }`. Local messages on a node get the node's own facts. (Desktop node: `ChatRunner.send(text,
  attachments, chat, origin)`; `main/devices/origin.ts` `messageOrigin(event)` gives the origin for any handler.) The prompt says, in one line, which device
  the message came from and its facts. `open_url` and `send_file` (and `notify` when the origin is a screen) go to the
  origin device as device commands (5.2); if the origin is this node, they act locally as today.
- **Brain choice (client side)**: the client keeps the ranked brain list (device rows, `roles` has `brain`, not
  revoked, by `priority`). It probes `/v1/health` (3 s timeout) in order and connects to the first `ready` one;
  re-probes every 15 s and on any failure, and moves back up when a higher brain returns, between turns only. The UI
  always shows "Answered by <name>". Only when every brain fails: "No agents available" with Retry.
- **Turn lease**: when a brain starts a turn it writes a `turn_lease` row (entity `turn` is already the model
  transcript) `{ id, kind: "turn|job", chatId, messageId, brainId, status: "running|done|failed|interrupted",
  attempt, heartbeatAt, startedAt, prompt }` and updates `heartbeatAt` every 10 s. Helper jobs do the same with
  `kind: "job"` and id `job-<helper id>`. A quit mid-turn leaves the lease `running` (resumed on the next start), like
  a crash. Before resuming its own leases a node with Devices on waits for one replication pass (up to 10 s), so a
  turn a peer took over while it was down is seen as the peer's.
- **Crash resume**: on start, a brain marks its own `running` turns `interrupted` and resumes them (re-runs the turn
  from the persisted chat history, telling the model it was interrupted and to continue without repeating finished
  side effects). A different brain claims a `running` turn whose `heartbeatAt` is older than 45 s and whose brain
  fails `/v1/health`, but only if it is the highest-ranked healthy brain it knows of; it bumps `attempt` and sets
  `brainId` to itself. Max 3 attempts, then `failed` with a visible note in the chat. "Fails" = no answer from any
  of its addresses within 3 s (pinned); "healthy" when ranking = answers with `ready: true`. A brain whose lease was
  taken (it was cut off, not dead) stops beating it, stops its own run of it, and does not end it.

## 9. Phone (screen) app

Revised 01:45 (owner's correction): both apps stay standalone; linking is optional; minimal changes.
- The phone app works exactly as before on its own (own keys, own data). Linking adds only "scan to link to a
  desktop or server" (QR, or address + short code). Store pass + brain list in Keystore-encrypted prefs. While
  linked, no AI keys are used or stored for it on the phone.
- While linked, the phone's EXISTING native screens show the brain's data and chat sends go to the brain over
  `/v1/rpc`. No WebView of the desktop UI, no new screens, no project list. Unlinking returns to local data untouched.
- The only new visible thing: a delegated project agent shows like a helper, with that project's icon and its live
  status line; plus a small "linked to <brain>" indicator and "No agents available" when every brain fails.
- The native layer handles brain choice and failover, device commands (open_url via Intent, send_file into
  Downloads, notify) and `hello` with DeviceFacts. Local images in chat load from `/v1/file` with the pass.
- The `/app/` web UI route is optional and not part of v1.

### 11.1 As built on the desktop node (workstream A)

- **Hello**: `{"type":"hello","device":DeviceFacts,"tools":DeviceTool[]}` (tools may also sit inside `device`). The
  node keeps them on the device row as `tools` (names `^[a-z][a-z0-9_]{1,63}$`, at most 80, schema up to 8 KB).
- **device.result(id, ok, valueOrError)** is answered by the node server itself (`DevicesHost.onDeviceResult`
  hears every one, with the calling deviceId); with `ok:false` the third argument is the error text.
- **What this desktop shares** (`main/devices/device-tools.ts`): its `browser_*` tools (the agent browser, its own
  tab), `notify_user`, `ask_user` and `request_approval` (the card shows in this app's main chat, the answer is
  returned), `files_list/read/find/write`, `file_send {path}` (bytes back inline, up to 16 MB) and
  `file_receive {name, data}` (saved under `<userData>/attachments/received`), and `shell_run` (group shell, off by
  default). Groups switch in Settings > Devices (`devices/config.json` `shareGroups`).
- **Value shape**: `{ text }`, plus `images: [{ type: "image", mime, data }]` when the tool showed pictures;
  file_send and file_receive answer `{ type: "file", name, mime, size, data }` and `{ type: "file", path, size }`.
  Deadline: `deadlineMs` clamped to 1 s .. 120 s (browser 600 s), default 120 s.
- **Linking out**: with Devices on, when the first brain in the order is another device, this node opens
  `/v1/rpc` to it as a device (its cert pinned from the brain's row, the node's own pass `devicesSelfPass` whose hash
  is in the pass table under the node's id, so the bundle carries it to the brains), says hello with its tools,
  runs `device.command` kind `tool` and answers `device.result`; `open_url` and `notify` commands act here and
  answer `device.ack(id, ok, note)`. It re-checks every 15 s and when device rows change. A brain-side router that
  targets the answering brain itself can call `DevicesService.runTool(command)`.
- **Devices off**: no identity files, no device row, no origin on messages, nothing listens or links out.
## 11. Shared device tools (added 01:50)

Any agent on any brain can use a tool that lives on another linked device (browser, notifications, files, shell,
approvals). General for any devices; nothing assumes a phone or a particular machine.

- **Advertise**: every device (node or screen) sends its tool catalogue in `hello` as `tools: DeviceTool[]` and the
  node stores it on the device row as `tools`. `DeviceTool = { name, description, params (JSON schema), group:
  "browser|notifications|files|shell|approval|phone|other", readOnly }`. Tool names are the device's own names
  (e.g. `browser_open`, `notifications_read`, `file_send`, `shell_run`, `ask_user`).
- **Call**: a brain sends a device command `{ kind: "tool", id, tool, args, chatId, deadlineMs }` (s5.2) to the
  target device; the device runs it and answers with RPC `device.result(id, ok, value | error)` (value JSON, images as
  `{ type: "image", mime, data base64 }` or a `/v1/file` path on the device's node). Default deadline 120 s,
  browser up to 600 s. While the device is offline the command waits in `device_command` (expires 10 min).
  A screen-only device (phone) reaches the brain over its existing `/v1/rpc` socket, so tools on it work without
  inbound connections to it.
- **Agent side** (every brain): two tools plus routing.
  `devices_list()` lists linked devices with kind, online, and tool groups.
  `device_tool(device, tool, args)` calls one tool on a named device (`device` by id or name, forgiving match, or
  `"best"`). Existing local tools gain an optional `device` argument where cheap (browser tools, notify, ask_user,
  send_file, open_url); without it they act locally, except open_url/send_file/notify which default to the origin
  device.
- **Router** for `"best"`: prefer the origin device if it has the tool; else a device the user marked preferred for
  that group in Settings > Devices (optional); else the online device with the tool, by brain priority, phones
  last for heavy work. If a local browser call fails with a block (HTTP 403/429, captcha, "access denied") the agent
  is told which linked devices have a browser and may retry there.
- **Approval on another device**: `ask_user` / `request_approval` with `device` puts the question on that device
  (on the phone: a notification with the buttons); the answer comes back as the tool result and work continues on
  the brain.
- **Safety**: only paired, non-revoked devices; each device may turn groups off ("Let other devices use my
  browser/notifications/files/shell"), default ON for browser, files, notifications, approval and OFF for shell.

As built (apps/desktop/src/main/devices/device-tools.ts, brain side):
- `tools` rides in hello inside the device facts (`device.tools`, DeviceFacts.tools in devices/types.ts); the node
  server must keep that field when it cleans facts. The hub copies it onto the device row (`tools`) every 3 s and
  before each call, so it replicates to every brain. A node lists its own tools on its own row.
- Phones (on RPC) get event `device.command` `{ id, kind: "tool", tool, args, chatId, deadlineMs }` and answer
  `device.result(id, ok, value | error)`; only the target may answer. Another NODE gets the same command through the
  synced `device_command` row (its DeviceToolRunner runs it and writes `result` into the row, which replicates back),
  so no node needs an RPC socket to another. Row fields added: `tool`, `args` (JSON), `result` (JSON), `deadlineMs`.
- The agent waits up to the deadline; a result that comes later is posted to the chat once as
  `[Device result: ...]`. Pictures `{ type: "image", mime, data }` are saved to files and shown to the model.
- Tool names: a device's own names; `notify_user` also matches `notify`/`notification_post`, `send_file` matches
  `file_send`, `open_url` matches `url_open`.
- Settings: `devicesPreferred` ({ group: deviceId }, shared through the bundle) and `devicesShareGroups`
  ({ group: boolean }, this device only). Defaults as above, plus `phone` on and `other` off.
- The runner on a node runs tools with no person to answer unless the app wires `context` (ask_user /
  request_approval on a NODE then answer "nobody could answer"); phones answer them natively.

## 10. Overlay network (optional, pluggable)

A sidecar (`agent-net`, Go, tsnet) can join a Tailscale-compatible control server (Tailscale or the user's own
Headscale) with an auth key the user pastes, and expose the node port on the overlay. Settings > Devices >
Network: None (LAN or direct address), Tailscale, Headscale (URL). The feature never depends on it.
