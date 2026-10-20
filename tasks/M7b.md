# M7b: Home, Tasks, Memory, Routines screens (renderer only)

The screens (M4) and the Runner/IPC (M6a) are merged here. Do ONLY the renderer part of `tasks/M7.md`: Home, Tasks, Memory, Routines on real data through `window.agent.data` with full CRUD, undo toasts, search, filters,
link graph, routine dialog, the "Run now" button calling `routines.runNow` (it may be a no-op until M7a merges: handle the rejection with a friendly toast), loading/empty/long-content states.
Gate: `bash scripts/gate.sh M7b` (includes `shoot.mjs --only data`). Report: `tasks/reports/M7b.md`.
