# M8a: Desktop-native, main process

Do ONLY the main-process part of `tasks/M8.md`: tray (`tray.ts`), global hotkey + Quick Ask window (`hotkey.ts`, main side and the `#/quick-window` route stub that the renderer owns later), launch at login, single instance, window state,
`tools/files.ts`, `tools/shell.ts`, `tools/code.ts` (register by appending one line each to `runtime/toolset.ts`), the pure helpers and their tests as listed in M8.md. `files.pick`, `files.pickFolder`, `shell.openExternal`, `shell.reveal` IPC handlers.
Gate: `bash scripts/gate.sh M8a`. Report: `tasks/reports/M8a.md`.
