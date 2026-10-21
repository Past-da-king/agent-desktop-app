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
  authenticated request is bound to the `deviceId` that owns the pass.

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
| GET | `/app/` | pass (cookie) | the web build of the renderer, using the remote bridge |
| GET | `/v1/file?path=<abs>` | pass | a local file named in a chat (images in cards, attachments). Only paths that appear in a chat row, the user's attachments folder, or project folders. `Content-Type` by extension. Range requests for big files. |
| GET | `/v1/bundle` | pass | section 6 |
| POST | `/v1/sync/push` | pass (node) | same body/answer as `packages/core/src/sync/client.ts` |
| GET | `/v1/sync/pull?cursor=&wait=` | pass (node) | same as above (long-poll up to 55 s) |
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

### 5.2 Device commands (tools that act on a device)

`{"type":"event","name":"device.command","payload":{"id":"cmd_...","kind":"open_url|send_file|notify|show_image","url"?,"path"?,"name"?,"title"?,"body"?}}`
sent ONLY to the connection(s) of the target device. The client acks with call `device.ack(id, ok, note)`.
If the target is not connected, the command waits in a `device_command` row (synced) and is delivered when it
connects, or expires after 10 minutes with a note back to the agent.
`send_file` gives `url: /v1/file?path=...` for the client to download with its pass.

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

## 7. Replication between brains

All brains hold the full row set. Each node keeps a change log (every applied row change gets a local sequence
number, with the originating device). A node replicates with every other reachable brain using the existing
push/pull protocol: it pushes changes the peer has not seen (per-peer cursor) and pulls the peer's log from its
cursor. Applying a change is idempotent (HLC). Changes are relayed, so A <-> B <-> C converges even if A cannot
reach C. Replication is initiated by whichever side can reach the other, so a node behind a firewall still syncs.

## 8. Turns, origin, failover, crash resume

- **Origin**: every user message row's `meta.origin = { deviceId, name, kind, platform, screenWidth, canOpenLinks,
  canReceiveFiles }`. Local messages on a node get the node's own facts. The prompt says, in one line, which device
  the message came from and its facts. `open_url` and `send_file` (and `notify` when the origin is a screen) go to the
  origin device as device commands (5.2); if the origin is this node, they act locally as today.
- **Brain choice (client side)**: the client keeps the ranked brain list (device rows, `roles` has `brain`, not
  revoked, by `priority`). It probes `/v1/health` (3 s timeout) in order and connects to the first `ready` one;
  re-probes every 15 s and on any failure, and moves back up when a higher brain returns, between turns only. The UI
  always shows "Answered by <name>". Only when every brain fails: "No agents available" with Retry.
- **Turn lease**: when a brain starts a turn it writes a `turn` row
  `{ id, chatId, messageId, brainId, status: "running|done|failed|interrupted", attempt, heartbeatAt, startedAt }`
  and updates `heartbeatAt` every 10 s. Helper jobs do the same with `kind: "job"`.
- **Crash resume**: on start, a brain marks its own `running` turns `interrupted` and resumes them (re-runs the turn
  from the persisted chat history, telling the model it was interrupted and to continue without repeating finished
  side effects). A different brain claims a `running` turn whose `heartbeatAt` is older than 45 s and whose brain
  fails `/v1/health`, but only if it is the highest-ranked healthy brain it knows of; it bumps `attempt` and sets
  `brainId` to itself. Max 3 attempts, then `failed` with a visible note in the chat.

## 9. Phone (screen) app

- Remote mode: "Link to my computer": scan the QR (or type address + short code), pair, store pass + brain list
  in Android Keystore-encrypted prefs. No AI keys stored in Remote mode.
- The chat, memory, tasks, routines and projects screens are the node's own web UI at `/app/` in a WebView, with
  TLS pinned (`onReceivedSslError` accepts only the pinned fingerprint) and the pass as a cookie. The native shell
  owns: scanning, brain choice and failover (reloads the WebView on the next brain, shows which brain answers),
  device commands (open_url via Intent, send_file into Downloads, notify as Android notifications), and sending its
  DeviceFacts (`hello`) through a small JS bridge.
- Local mode (its own key / subscription on the phone) keeps working as before.

## 10. Overlay network (optional, pluggable)

A sidecar (`agent-net`, Go, tsnet) can join a Tailscale-compatible control server (Tailscale or the user's own
Headscale) with an auth key the user pastes, and expose the node port on the overlay. Settings > Devices >
Network: None (LAN or direct address), Tailscale, Headscale (URL). The feature never depends on it.
