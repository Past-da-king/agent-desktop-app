# agent-desktop: the agent's own desktop for real-input apps

A small Windows-only native sidecar (C#, .NET Framework 4.x, JSON lines over stdio, like
`tools/agent-screen`). It gives the agent a **separate desktop object on WinSta0** that the user
never sees, launches an app there, captures it and sends input to it, without ever touching the
user's pointer, keyboard or focus. The PC equivalent of the phone app's background screen.

Stage 3 of the decision "the agent never takes his mouse, keyboard or focus (11 Nov 2026)". For
the full comparison of mechanisms, the limits and what needs admin, see `docs/agent-desktop.md`.

## Protocol (one JSON object per line in, one per line out)
- `{"cmd":"open","name":"AgentDesk1"}` -> `{"ok":true,"desk":"AgentDesk1"}` (name optional)
- `{"cmd":"launch","app":"C:\\Windows\\System32\\charmap.exe","args":"..."}` -> `{"ok":true,"pid":123}`
- `{"cmd":"windows"}` -> `{"ok":true,"windows":[{"hwnd":..,"title":..,"pid":..,"x":..,"y":..,"w":..,"h":..}]}`
- `{"cmd":"capture","hwnd":123,"path":"C:\\...\\shot.png"}` -> `{"ok":true,"w":..,"h":..}`
- `{"cmd":"click","hwnd":123,"x":200,"y":200}` -> `{"ok":true}` (client coords, PostMessage)
- `{"cmd":"type","hwnd":123,"text":"hi"}` -> `{"ok":true,"chars":2}` (WM_CHAR)
- `{"cmd":"close"}` -> `{"ok":true,"killed":N}`

**Every reply carries `cursorMoved` and `foregroundChanged`.** The sidecar reads `GetCursorPos`
and `GetForegroundWindow` before and after each command; both must stay `false`. This is the
input-safety guard the decision requires.

## Build
`tools/agent-desktop/build.cmd` on Windows only (the csc.exe that ships with .NET Framework 4.x).
Nothing to install. Output: `bin/win-x64/agent-desktop.exe`. The exe is committed because the
installer is built on Linux where that compiler does not exist: after changing `src/Program.cs`,
run `build.cmd` on Windows and commit the new exe with the source.

## Proven on Windows 11 Pro 26200 (25H2), no admin
- Create the desktop, launch Character Map there, list its window, capture it (a real PNG), click
  and type, tear down. His cursor and foreground never changed (guard `false` on every command).
- Edge (Chromium) with a fresh `--user-data-dir` launches and renders there; its **browser chrome**
  captures, but the **web content area comes back black** (GPU compositor, not printable off the
  input desktop). Use CDP for Chromium/Electron content, not this surface.

See `docs/agent-desktop.md` for the capture and input limits and the fallback.
