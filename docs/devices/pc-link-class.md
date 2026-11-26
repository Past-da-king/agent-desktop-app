# PC link bug class (0.2.148, 26 Nov 2026)

On 26 Nov 2026 Windows Tailscale on the PC wedged in NoState and the Windows clock ran 35 minutes slow. The server
and the phone could not reach the PC app. The main agent worked around it by hand with socat relays in WSL and hand
edits to `devices/config.json` and `node.json`. Five defects made that necessary. Each is fixed for the whole class,
not just for that morning's addresses.

## 1. Extra addresses never reached the device row

Cause: `DevicesConfigFile` read `devices/config.json` once, in its constructor. An address added to `extraUrls` while
the app ran (by hand, by another program, by a restore) was never published, and the app's next save of any Devices
setting would have written the old list back over the edit. The server's copy of the PC row (stamped by the PC's own
replica) still listed only the interface addresses, while the file held the WSL relay address.

Two more members of the class:

- After `setExtraUrls` this node did not say hello again on its uplink, so the answering brain kept the old facts of
  the hello and wrote those addresses back onto this node's row every minute (`seen()`).
- The headless node replaced the Devices `extraUrls` with `node.json` `publicUrls` on every start, so an address set
  with `devices_addresses` while it ran (the server's local relay address) was lost on the next restart.

Fix:

- `DevicesConfigFile.reload()` re-reads the file when its mtime, size or inode changed. `save()` reloads first, so a
  hand edit is kept. A broken or half-written file is not taken.
- `DevicesService.checkConfig()` runs every 5 s (`CONFIG_CHECK_MS`). On a change it rewrites this node's row, applies
  the WSL relay setting and says hello again.
- `writeSelf()` says hello again on the uplink whenever the published addresses change.
- Headless: the start merges `publicUrls` with the Devices `extraUrls`, and `onExtraUrls` writes changes back into
  `node.json`, so both stay one list.

Tests: `test/devices-extra-urls-published.test.ts`.

## 2. node.json brain addresses went stale

Cause: `node.json` `brains[].urls` were written at pairing and never updated. Replication puts a row's addresses
first (`mergePeers`), but every reader of `node.json` (replication extras, relay tool, runtime targets, `status`)
kept trying the PC's old LAN address forever, and an address the PC never published (the WSL relay) had
to be added by hand.

Fix: `headless/brain-urls.ts` `BrainUrlRefresher`. It runs when a device row changes, and once a minute it probes the
addresses that are not the row's.

- The row's current addresses are taken in the row's order.
- An address the row published before (`learned`) and no longer publishes is dropped.
- An address from elsewhere (the pairing link, a hand edit) is kept. If it answers now it goes first; if it is not
  yet known to work it goes last. It is dropped only once proven dead: `DEAD_AFTER` (5) failed checks in a row over at
  least `DEAD_SPAN_MS` (10 minutes), while the brain answers on another address.
- `pinned` addresses (set by hand in `node.json`) are never dropped and always go first.

No restart is needed. Every reader reads `node.json` each time.

Tests: `test/headless-brain-urls.test.ts`.

## 3. The freeze watchdog did not fire

Evidence, from the PC's `main.log`, PC clock (35 minutes slow):

- 00:55 to 01:19: every read in the database read workers waited 17 to 21 minutes. `list device` (6 rows) took 1,269 s
  and `list job` took 1,156 s. The main thread stayed alive: it was blocked for only 4 to 8 s at a time.
- `Devices TLS handshake failed ECONNRESET` repeated: other devices could not get through.
- 01:39:19 (the restart after the manual taskkill): `Freeze watchdog did not connect within 30 seconds`. The main
  thread was blocked for 36.9 s at start, including a 12.9 s `spawnSync`.

Cause: the supervisor only watched heartbeats sent from the main thread. The main thread kept beating, so a server
that accepted TCP but never answered could not be seen. All ages were measured with `Date.now()`. A wall clock that
jumped back (Windows time correcting a slow clock) made `now - last` negative, which delayed detection by as much as
the jump. The 30 s connect timeout looked like a failure even when the supervisor connected later.

Fix (`main/freeze-recovery.ts`):

- Every beat carries the Devices server's local target (`DevicesService.probeTarget()`).
- Every 15 s the supervisor sends `GET /v1/health?deep=1` over TLS on the same port and path other devices use.
  `deep=1` also does one read through the database read queue (`Store.probe()`). It answers 503 `stuck` if that read
  does not come back within 8 s.
- After the server has answered once since start, 180 s with no good answer while the main thread still beats counts
  as frozen: diagnostics, the unavailable marker, the restart within the existing cap, and readiness confirmation.
  A server that never came up, or Devices switched off, never counts.
- Every age uses `performance.now()` (monotonic). The wall clock only stamps logs and the restart history; a stamp in
  the future still counts toward the cap.
- A late supervisor connection is logged. Scripts left by dead supervisors are tidied away at start.

Tests: `test/freeze-recovery-probe.test.ts` covers a server that refuses connections and a server that hangs, both
with the main thread beating; a healthy app; a server that never came up; Devices off; a clock jumping back 35
minutes; a clock jumping forward 35 minutes; the cap with future stamps; script tidy-up. The deep route is tested in
`devices-extra-urls-published.test.ts`.

## 4. Startup read 566 MB of chat rows

Cause: the window's first `load('chat_item')` (`App.tsx`) calls `data.list`. On the main process that is
`store.list('chat_item')`: every chat row with its full payload, read in a worker, then parsed on the main thread,
then cut by `lightRow` to 240 characters of each run output. It also kept the two read workers busy for the whole
read, so everything else queued behind it.

Fix: `Store.listLight()` asks the read workers to apply the same cut (`db-reader.ts lightPayload`, kept in step with
`shared/light-row.ts` by a test) before rows cross to the main thread. Rows, order and content are the same.
`lightRow` still runs in `ipc.ts` and finds nothing left to cut. Without workers it is `list()`, as before.

Tests: `test/db-light-list.test.ts` (equivalence, deleted rows, broken meta, the fallback). Measurement:
`LIGHT_BENCH=<rows> npx vitest run test/db-light-list-bench.test.ts` (skipped by default).

## 5. WSL relay fallback (Settings > Devices, off by default)

"Reach this computer through WSL when Tailscale is down", Windows only (`main/devices/wsl-relay.ts`). When it is on,
the app checks every 60 s:

- Windows Tailscale running (`tailscale status --json` BackendState `Running`): the relay is idle and the status line
  says it is not needed.
- Windows Tailscale down, wedged, hung or missing, and WSL has its own Tailscale address: a forwarder inside WSL
  (`wsl.exe -e python3`, standard library only, or socat) listens on WSL's overlay address at the Devices port + 1
  (the next free port if that one is taken) and passes connections to the app. Mirrored networking uses
  `127.0.0.1`; NAT uses the WSL gateway. That address goes last in this computer's advertised addresses, so a working
  direct address is always tried first.
- For each paired brain or hands device with an overlay address, a forwarder on `127.0.0.1` inside WSL reaches it.
  That address is only used on this computer: it is added after the device's own addresses for replication, the
  uplink and the answer-order health check, and it is never published.

TLS and the certificate pin pass through untouched. The forwarder exits when the app's pipe closes. Nothing is
written to WSL or to a config file. The status line in Settings > Devices says what it is doing and why.

Tests: `test/devices-wsl-relay.test.ts`, including a real run of the Python forwarder.

The hand-made relays on the PC (`agent-relay`, `agent-relay-out`) stay as they are until Ayanda restarts Tailscale.
If this option is switched on while they run, the inbound port 7788 is taken, so the built-in relay uses 7789 in WSL.
