# Clock skew between devices

## What went wrong (26 Nov 2026)
The PC's Windows clock ran 35 minutes slow (w32time stopped, Source: Local CMOS Clock). The desktop stamped new
chat rows with its raw clock, and the phone numbered each arriving row by the sender's createdAt and sorted by that
number. Every reply from the PC landed 35 minutes up the phone's chat, out of view. Replication (HLC stamps) was fine.

## The fix, as a class
1. **One corrected clock per node** (`packages/core/src/sync/peer-clock.ts`, app instance `main/clock/app-clock.ts`).
   - Every `/v1/sync/push` and `/v1/sync/pull` answer carries `now` (the answering node's RAW clock), `heldMs` (how long
     a long poll was held) and `clockSynced` (its OS says its clock is synced).
   - Each link takes an NTP-style sample: transit = round trip minus heldMs, offset = peerNow minus the midpoint.
     Samples with more than 10 s on the wire, or offsets over a week, are dropped.
   - Who is right: our own OS says synced: no correction. Else peers whose OS says synced: their median. Else, our OS
     says not synced: the median of the other peers. Else two or more peers that agree within a minute. Else nothing.
     Under a second is noise.
   - OS check every 10 minutes: Windows `w32tm /query /status` (service stopped, Local CMOS Clock or Free-running
     System Clock = not synced), Linux `timedatectl show -p NTPSynchronized`, others unknown.
2. **The store stamps with it** (`main/db.ts`): `new Store(file, () => appClock.now())`, and a new chat row is never
   stamped before the newest chat row already held (from any device), unless that row is more than a day ahead
   (a broken clock is not followed). Rows written with an explicit createdAt keep it.
3. **Phone** (`Past-da-king/agent`, remote/RemoteRows.kt): a main-chat row that arrives live and is new to the phone
   gets a local id after the newest row it holds (`RemoteIds.localAfter`, `RemoteRows.liveFloor`). Full reads and Load
   earlier keep sender order. A live row written more than 6 hours before the newest held row counts as history.
4. **send-once** (`main/runtime/send-once.ts`): the 15 s stale check only applies while the phone's and the brain's
   clocks agree within two minutes; past that the age cannot be measured, and the caller-gone and duplicate checks
   still hold back a frame that sat in a frozen socket. The gate uses the corrected clock.
5. **Settings > Devices** shows "Clocks do not agree" when the correction is over two minutes (this device is off) or a
   peer differs by more than two minutes (that device is off).

## Limits
- A node whose only peer is a phone gets no samples (phones do not replicate over /v1/sync).
- Rows already written with a wrong time keep it.

Tests: `apps/desktop/test/clock-skew.test.ts` (-35 and +35 minutes, two real nodes), `send-once.test.ts`.
