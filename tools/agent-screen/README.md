# agent-screen

The Windows screen reader behind "show me how": a small helper process the desktop app starts while it
walks someone through a task on any window. The app side is `apps/desktop/src/main/showme/native`
(`createScreenReader()`), behind the interface in `apps/desktop/src/main/showme/screen.ts`.

It reads other windows through Windows UI Automation (the COM client), so it works with browsers
(Chrome, Edge, Brave, Firefox), Electron apps and ordinary Windows apps without anything installed in them.

## What it does, and what it never does

- Reads a window's controls, finds one by name, follows its rectangle, captures a window or a screen
  area as PNG, and reports clicks, the wheel, and a few named keys.
- It never clicks, types, blocks, delays or swallows input. There is no code in it that sends input.
- One request changes which window has the keyboard: `focus` brings a window to the front, as a click on its title
  would, and only while the caller's own window (or none) has the keyboard. Nothing is typed or clicked.
- A followed element counts as out of sight for 650 ms after the page scrolled under it: the wheel, a key that
  scrolls a page (PageUp, PageDown, Home, End, the arrows, Space, not while a text field has the keyboard), or a drag
  with the button held (a scroll bar). These are noted inside the helper and never sent anywhere.
- The mouse and keyboard hooks exist only between `{"op":"input","on":true}` and `{"op":"input","on":false}`.
  Each callback reads a few numbers and passes the event on. The only keys that leave the process are the
  names the caller asked for, and "paste" for Ctrl+V or Shift+Insert. Nothing typed is logged or stored.
- The value of a password field is never read.
- It exits when its stdin closes or its parent process dies.
- Every rectangle is in physical screen pixels (the process is per-monitor DPI aware).

## The lines it speaks

One JSON object per line. Requests carry an `id` and an `op`; the answer carries the same `id`.

| op | arguments | result |
| --- | --- | --- |
| `hello` | | `{ version, pid, elevated, idleMs, hooks }` |
| `exclude` | `pids` | these processes' windows are never "the active window" (the parent is always one) |
| `activeWindow` | | the window in front, or the one behind it when the front one is excluded; with `url` for a browser |
| `window` | `hwnd` | the same shape for one window |
| `windows` | | every window a person could be working in, front to back, no `url` |
| `monitors` | | `[{ device, bounds, work, scale, primary }]` |
| `tree` | `hwnd`, `max`, `interactiveOnly` | `{ seen, nodes }`: on screen, named, usable controls |
| `find` | `hwnd`, `name`, `role`, `nth` | `{ node, matches, road }`; `road` 1 exact and stops at the first, 2 exact over the whole window, 3 loose |
| `watch` | `hwnd`, `node`, `name`, `role` | `{ watch }`, then `move` events about 30 times a second while it moves |
| `unwatch` | `watch` | |
| `capture` | `hwnd`, or `x y width height`; `maxWidth` | `{ width, height, how, png }` (base64) |
| `input` | `on`, `keys`, `clickOn` | installs or removes the hooks; then `input` events |
| `focus` | `hwnd` | `true` when that window has the keyboard now, else the reason in a few words. For the moment of the hand-over the helper joins the input of the caller's window and of the target (AttachThreadInput): Windows refuses it otherwise. |
| `quit` | | exits |

Events: `{"event":"move","watch":1,"rect":{...}|null,"why":"moved|hidden|gone"}` and
`{"event":"input","kind":"click|key|paste|wheel|foreground",...}`.

Refusals: `{"id":1,"ok":false,"code":"elevated|timeout|no_window|failed","error":"plain words"}`.
A window that runs as administrator cannot be read unless the app does too; it says `elevated`.

## Building

`build.cmd` on Windows. It uses the C# compiler that ships with Windows (.NET Framework 4.x), so there
is nothing to install, and the exe needs nothing beyond what Windows 10 and 11 already have.

The exe is committed at `bin/win-x64/agent-screen.exe` because the installer is built on Linux, where
that compiler does not exist. After changing `src/`, run `build.cmd` and commit the new exe together
with the source. `obj/` (the generated interop types) is not committed.

electron-builder packs it to `<resources>/agent-screen/` (`apps/desktop/electron-builder.yml`); the app
looks there, then in `AGENT_SCREEN_PATH`, then here.

## Proving it

`node tools/agent-screen/proof/proof.mjs` (Windows, Node 22.18 or newer, no install, no Agent app):
it opens its own Chrome with a throwaway profile on a small site it serves, and Character Map, and
checks and times everything above, including whether a rectangle lands on the element's true pixels in
a screenshot. It plays a few real clicks and keys through `proof/send-input.ps1` to see them arrive;
that script is part of the proof only. It closes everything it opened.
