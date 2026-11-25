# Answer order and frozen-main recovery

25 November 2026. Desktop/node 0.2.146, phone companion 0.15.77. No live installation is part of this change.

## Reproduced faults

`setPosition` already tried to renumber, but background self/hello/last-seen updates wrote full old device rows. A delayed metadata write could restore an old priority after an order edit. The regression test recreates two priority-zero brains on the original source. Metadata now updates only its own fields. Order edits are serialized, renumber every brain and use the store's transaction batch. A first observed legacy tie is repaired once and recorded in the local Devices config.

The three tie-breaks disagreed: Settings used pairing time, lease failover used id, and the phone used display name. All now use priority, pairing time, then device id. Pairing time is additive on the brain wire record. A remaining tie is stated explicitly in status.

A metered phone skipped preferred-brain probes whenever its current socket was open, including after a turn-finished kick. The phone now checks on the next idle send and a device health event, serializes selection/delivery, and keeps active turns on their owner. The node also asks idle phone/tablet screens to reconnect after two healthy preferred-brain checks, once per recovery, so an older phone can move back without a reconnect loop. Wake-only sockets remain open. Busy main turns are never moved.

## Status and disk

Settings > Devices and `devices_status` expose `answering`; the phone shows its actual connected brain and reason in Connections > Your machines. The phone reports ties and passes through the current brain's disk warning. The new optional fields remain compatible with older clients.

The independent recovery process samples free space on the app data drive every 15 seconds. Warn below 3% of capacity, bounded to 5–20 GiB; stop accepting new messages below 1%, bounded to 2–5 GiB. A critical device resumes only above 1.5 times its stop threshold. One notice is emitted per state transition. Local sends are refused before acceptance; remote message sockets close before acceptance so the phone's existing send id safely retries elsewhere. Current turns may finish in place.

## Watchdog

A separate Electron-as-Node process receives one-second main-process heartbeats. It allows 120 seconds for startup, detects 60 seconds without a heartbeat, and gives both processes a fresh grace interval after system suspend/resume. It writes `logs/freeze-watchdog.log`, an unavailable marker, and a durable restart budget before killing only its own parent. It relaunches the same executable and arguments, preserving the test/data-folder environment. Existing WAL and durable turn leases perform crash recovery; no database or lease is rewritten by the watchdog.

Backoff is 1, 2, 4 seconds, capped at 30 seconds, with at most three restarts in 30 minutes. Malformed budget state, unwritable diagnostics or critically low disk refuse restart. The supervisor starts before opening the database and stops before shutdown cleanup. Low-disk holds keep monitoring: when disk space and the same main process recover, its unavailable flag clears without spending a restart. A normal stop/disconnect never relaunches. The marker makes a thawed process not-ready until a fresh process starts. The budget survives restart. Diagnostics include the last heartbeat memory figures; a blocked main process cannot guarantee a stack. The existing sampling watchdog remains available for recovered stalls.

## Incident evidence and limits

Retained PC log ends at 10:37:25.419 UTC on 25 November, a worker read of 9,185 jobs taking 2,339 ms; next entry is startup 0.2.143 at 10:51:03.109 UTC. Earlier low-disk placement messages on 24 November show 2.2 and 2.1 GiB. No retained ENOSPC, SQLITE_FULL or permanent-hang stack proves the exact frozen call. The previous watchdog explicitly waited for the stall to finish before posting its report to the main logger.

The main agent found and removed repeated 2.6 GB WSL Node crash dumps, restoring C: to 21 GB. Read-only follow-up confirmed C: 476G total, 456G used, 21G free and an empty `%LOCALAPPDATA%/Temp/wsl-crashes`. WSL's core pattern is `|/wsl-capture-crash %t %E %p %s`. No retained kernel journal, core file or dump filename identifies the exact Node executable or parent after cleanup. That attribution remains open; this change does not invent one or delete further files.

## Validation

Regression tests cover the delayed metadata overwrite, whole-list order edits and boundary arrows, shared tie ordering, status, safe refusal before acceptance, stable handback without moving active turns, a disposable process that stops heartbeating, diagnostic-before-kill, persisted restart caps, clean stops, and disk hysteresis. The original metadata and lease-order regressions were observed failing before their fixes. Phone tie ordering likewise fails before its comparator correction. Full-suite and artifact evidence is recorded in the release handoff.

Merged source includes the headless voice-note/media fix from devices d3ae2e4 and 9199ec6. Typecheck passed. Full Vitest on that combined tree: 3,069 passed, 33 skipped, 3 failed; two unhandled asynchronous cleanup errors. The known socket and git-hook failures remain. The recording-manifest timing assertion was separately reproduced on untouched f6dd4ec. PendingTakes' cleanup rename rejection also occurs before this change in the voice branch full run; the MiniAppStore.opened callback writing after Store.close was reproduced deterministically against untouched f6dd4ec. These existing failures are not described as a green full suite.

Two isolated headless nodes initially proved idle handback in 28.141 seconds, no reconnect loop when the scripted phone returns to its stand-in, distinct priorities 0/1, and one question/one answer despite resending the same send id. A second proof additionally suspends and resumes only the disposable preferred node; its final evidence is in the release handoff.
