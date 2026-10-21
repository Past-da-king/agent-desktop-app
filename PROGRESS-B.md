# PROGRESS B: replication, bundle, origin, device commands, turn leases, crash resume

Branch `devices-sync` (off `devices`), worktree `~/agent-desktop-wt/devices-sync`. Contract: `docs/devices-protocol.md` s4-s8.

## Done
- New synced entities: `device`, `device_command`, `turn_lease` (core ipc.ts types, change.ts, db.ts, renderer lists).
  `turn` was already the model transcript, so the s8 lease row is `turn_lease`.
- db.ts change log (`change_log`: seq, entity, cid, via). `applyRemote(changes, via)`, `changesAfter`, `logSeq`,
  `localValue`. Backfilled from existing rows on first open.
- devices/replicate.ts: `registerSyncRoutes(host, store, bundleVersion)` (push/pull, long-poll, skip-via) and
  `Replicator` (one link per peer, per-peer cursors in kv, nudged on local writes, multi-url, backoff).
- devices/pinned-fetch.ts: https fetch pinned to the peer's fingerprint; nothing is written before the pin check.
- Tests: apps/desktop/test/devices-replicate.test.ts (7) over real local HTTP: relay A<->B<->C, conflict, peer down.

## In flight / next
- bundle.ts, commands + tools, origin line, turn leases + crash resume + failover.
