# M8a: Desktop-native, main process

## What was built

- **Tray** (`apps/desktop/src/main/tray.ts`, `tray-menu.ts`): the menu is built by a pure function so it can be
  tested without Electron. Items: Open Agent, Quick Ask, `Needs you (n)` only when a question or approval card is
  waiting, Pause/Resume routines (checkbox), Quit. Static PNG icons in `apps/desktop/resources/` (16px and 32px,
  mascot-coloured face) generated without a canvas. Tray creation is wrapped, so a Linux session without a tray
  still starts.
- **Close to tray**: `Settings.closeToTray` (default on) hides the window instead of quitting, keeps routines and
  sync alive, and shows the "Agent is still running in the tray" notification the first time. Quit from the tray
  sets the quitting flag so the window really closes; `before-quit` tears down the shortcut, tray and quick window.
- **Global Quick Ask** (`hotkey.ts`): `HotkeyBinder` is pure over an injected shortcut registry. It registers
  `Settings.quickAskHotkey`, unregisters the old accelerator before registering a new one, and reports failure.
  `QuickAskWindow` is the frameless 640x180 always-on-top centred window; it hides on blur and on Esc, loads the
  renderer at `#/quick-window`, and re-sends the quick-ask event when it is reopened.
- **Launch at login** is applied from `Settings.launchAtLogin` at startup and whenever settings change
  (`app.setLoginItemSettings`, wrapped because Linux desktops can refuse it).
- **Single instance**: the lock focuses/restores the existing window, including a window that was hidden to the tray.
- **Window state**: existing size/position/maximised restore kept, minimum size kept, `thickFrame: true` added so
  Windows 11 snap layouts keep working on the frameless window.
- **Tools**: `tools/files.ts` (`files_list`, `files_read`, `files_write`, `files_find`, `files_pick`, `files_move`),
  `tools/shell.ts` (`shell_run`), `tools/code.ts` (`run_code`); appended to `runtime/toolset.ts`.
  - Paths are expanded (`~`), resolved, then made real before any check. Granted folders are made real too. A file
    outside them, not picked by the person, needs `ctx.approve` for each operation. Symlinks are resolved first, so a
    link inside a granted folder that points outside still asks. `files_find` does not descend through symlinks.
  - `files_write` and `files_move` report plainly when declined; nothing is created in that case.
  - `shell_run` asks every time with the exact command, refuses outright when `Settings.shell === 'never'`, runs
    through the platform shell, defaults to 60 s (max 600), caps output at 20000 characters and kills the process
    group on timeout or abort. The child environment is filtered of names matching `/KEY|TOKEN|SECRET|PASSWORD/i`.
  - `run_code` runs Node or python3/python in a fresh temp folder, asks first, times out at 30 s, and reports the
    files it created with absolute paths.
- **IPC**: `files.pick`, `files.pickFolder` now use real OS dialogs injected into `registerIpc`; `shell.openExternal`
  and `shell.reveal` stay real. The contract gained `HotkeyStatus` and `window.onHotkeyStatus` (preload and mock
  updated) so Settings can show a failed shortcut registration. The status is re-sent to each window after it loads,
  because registration happens before the renderer is ready.
- **Attachment rule**: `MAX_ATTACHMENT_BYTES` and `attachmentProblem(name, size)` live in `@agent/core`
  (`attachments.ts`) so the renderer's drop target and the main process share one 20 MB rule.
- **Tests**: `files-tool.test.ts` (granted folder, `..`, symlink escape, absolute outside, Windows case tricks,
  approval, picked files, read cap, image marker, move, find), `shell-tool.test.ts` (approval text, decline,
  `never`, env stripping, timeout, abort, output cap, missing cwd), `code-tool.test.ts` (output, files created,
  decline, timeout, missing runtime, Python when present), `tray-menu.test.ts`, `hotkey.test.ts` (fake registry),
  `drop.test.ts` (20 MB rule and mime guess). Full suite: 212 tests passing.

## Deviations and things the next milestone must know

- This branch has no scheduler (M7a is separate). The tray's Pause/Resume routines item is a real toggle of the
  tray state, but nothing consumes the paused flag until M7a is merged: the scheduler should read `routinesPaused`
  in `index.ts` (via `trayState`) or a pause module introduced then.
- `#/quick-window` is main-side only: the window loads that hash now, but the route itself (and sending the typed
  text through `chat.send`, showing the answer inline) is M8b renderer work. Until then the small window shows the
  normal app UI.
- Double-click on the title bar to toggle maximise still belongs to the renderer's TitleBar (`window.toggleMaximize`
  already exists in the contract). The main window is snap-friendly.
- Settings must render the `window.agent.window.onHotkeyStatus` message ("Could not be registered...") and the
  granted-folder editor; `files.pickFolder` returns an absolute path for that editor.
- `files_pick` grants the chosen paths for the rest of the session (an in-memory set). A restart asks again.
- `run_code` asks on every run rather than only the first; the milestone's wording ("approval first time per run")
  was read as "before each run", which is the safer of the two.
- No new dependencies were added. Icons are hand-written PNGs (zlib + CRC, no canvas) checked with `file`.
