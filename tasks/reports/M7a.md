# M7a report: scheduler and routine tools (main process)

## What was built

- `apps/desktop/src/main/runtime/scheduler.ts`: the routine scheduler. Ticks every 30 seconds, on app
  start and on `powerMonitor` resume. Due rules for `at` (once), `daily` (local `HH:mm`, once a day) and
  `interval` (minutes since the last run, or since creation). Missed slots are caught up once on start.
  Ticks and "Run now" share one queue, so two routines never run together. Writes `lastRunAt` and a
  300-character `lastResult`, and disables `at` routines after they run.
- `Runner.runRoutine(trigger)`: the ROUTINE-role run. It uses a routine variant of the system prompt
  (background, nobody watching, finish with a short summary), runs with its own AbortController and
  leaves no turn rows or agent chat rows behind. A question or approval posts the normal card and ends
  the routine with "Waiting for you"; answering the card later continues in the main chat, the same way
  a restart does. `resolveModel` was extracted so routine and chat runs share one set of setup checks.
- `apps/desktop/src/main/tools/routines.ts`: `routine_create` (asks `ctx.approve` first), `routine_list`
  and `routine_delete`, registered by one line in `runtime/toolset.ts`. Specs are validated per kind
  (`at` must parse and be in the future, `daily` must be a real `HH:mm`, `interval` is whole minutes,
  at least 15, as on the phone).
- `routines.runNow` IPC handler, with argument validation. A paused routine can still be run on demand.
- `apps/desktop/src/main/notify.ts`: needs-you and routine-result notifications, shown only when the
  person allowed notifications and the window is not focused. A click focuses the window and routes to
  the card (`chat`) or the routine (`routines`). Added `window.onRoute` and `EVENTS.route` to the
  contract, preload and mock bridge, so the renderer can act on that click (M7b consumes it).
- `apps/desktop/src/main/index.ts` wiring: scheduler starts after `runner.restore()`, resume listener,
  clean stop on quit, and the notifier's `needsYou` passed as `notifyCard`.
- Tests: `scheduler.test.ts` (12 tests, including due logic for every kind, catch-up, no overlap,
  `at` disabling itself, Run now, waiting result, notifications), `tools-routines.test.ts`,
  `runner-routine.test.ts`, `routine-prompt.test.ts`, `notify.test.ts`, and the updated IPC contract
  test. Suite is now 197 tests.

## Decisions worth knowing

- Routine runs deliberately do not add rows to the main chat or `turn` table. Their outcome lives in
  `trigger.lastResult`, and anything the person must act on is posted as a question or approval card.
  This keeps background work from filling the conversation; M7b shows the result on the Routines screen.
- Interval routines with no `lastRunAt` count from `createdAt`, so a freshly created routine does not
  fire the moment it is saved.
- The notification wrapper takes Electron's `Notification` through an injected factory, so the
  focus/enabled/click behaviour is unit tested without Electron.
- `at` specs are parsed as local time (`parseWhen` from the task tools already does this); the phone's
  Kotlin `parseWhen` is the reference.

## Not finished

- No renderer reads `window.onRoute` yet. M7b should subscribe and open the chat card or the routine.
- Goal ring counts are derived by the renderer from goals and tasks; there is no main-process helper,
  so the "store-level tests for goal ring counts" line in M7.md belongs to M7b.
- M7a's gate does not run screenshots; the data screenshots are M7b's job.

## For the next milestone

- `AgentApi.window.onRoute(cb)` is new and `EVENTS.route` carries `{ view: 'chat' | 'routines' | ... , id }`.
  The mock bridge implements it as a no-op listener.
- `RunnerDeps.notifyCard(itemId, title, body)` is the card-aware notification hook; keep it when adding
  more runners.
- `buildToolset` now has one extra line; M8/M9/M10 should keep appending one line per group.
