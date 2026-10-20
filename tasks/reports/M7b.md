# M7b report: Home, Tasks, Memory, Routines (renderer)

## What was built

The four data screens now run entirely on `window.agent.data`. They share the existing bridge, so the same code works against the Electron store and the browser mock.

- Home: greeting from settings, a "Right now" hero that follows the live run (tool activity and goal wave) or the most recent agent reply, amber needs-you cards with answer and approve actions, open user to-dos in due order, inline add, edit dialog, delete with Undo toast, goal rings, coming-up list, and the this-computer card. Loading and empty states are kept.
- Tasks: "My to-dos" and "Agent's work" tabs, master-detail, create in a real dialog, edit title, notes, due date (native date input styled with tokens), status, goal and blocker, delete with Undo toast, and long titles wrap instead of overflowing.
- Memory: 150 ms debounced search over title, body and topics; kind chips; pinned pages first; markdown-lite body with working `[[links]]`; unknown links offer "Create page"; edit worksheet for title, kind, topics and body; pin; delete with Undo toast; link graph built from real page titles.
- Routines: schedule in plain words, last run and result, enabled switch, create and edit dialog with at/daily/interval controls and a per-kind spec input, "Run now" both in the next-up hero and on each card, and delete with Undo toast. A rejected `routines.runNow` is caught and explained in a friendly toast.
- A small toast store and accessible toast surface (`aria-live`) were added for undo and routine feedback.

## Tests

`apps/desktop/test/data-views.test.ts` covers memory search and link resolution, task ordering, date input round trips, routine schedule labels and toast expiry. Full suite: 185 tests passing and `bash scripts/gate.sh M7b` prints GATE M7b PASSED. `npm run typecheck`, `npm run build`, `shoot.mjs --only screens` and `shoot.mjs --only data` all pass locally. The interaction paths (add, edit, delete, undo, search, create-page, edit routine, run now) were also exercised against the built renderer in headless Chromium.

A later gate run failed one core sync test (`SyncClient` long-poll timeout) because it measured elapsed time with `Date.now()`. The host wall clock was corrected backwards during the wait, so the test saw a negative elapsed value. The test now uses the monotonic `performance.now()`, which measures the wait correctly regardless of a clock adjustment. It passed five repeated runs and the full gate afterwards.

## Not finished / notes for the next milestone

- This milestone is renderer only. `routines.runNow` still answers "not implemented yet" in this branch's main process until M7a merges; the button handles that rejection with a toast rather than failing silently. The same applies to anything behind the scheduler.
- Home keeps its own small run-state hook (`state/useRun.ts`) because Chat still owns local run state. M10 can unify them when helper runs arrive.
- No dependencies were added.
