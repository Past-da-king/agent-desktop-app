# Agent cursor: handover (Wed 11 Nov 2026, 12:35)

Stopped on Ayanda's order at 12:29, about 20 minutes into the work. This is everything the next agent needs.
Branch `feat/agent-cursor`, cut from `devices` e000b10 (0.2.125). Nothing is merged, no version bump, no installer.

## The job (unchanged)

The agent must never take his mouse, keyboard or window focus. Four parts plus one added at 12:22:

1. No-cursor input: tools `screen_windows`, `screen_read`, `screen_act`, with a ladder (UI Automation, CDP, posted
   messages) and a verified result.
2. A visible, branded agent cursor in the capture-protected overlay.
3. The agent's own desktop for apps that only take real input. Another helper finished it: branch
   `feat/agent-desktop`, head ce34feb (CreateDesktop on WinSta0, never SwitchDesktop). NOT merged here yet.
4. One lock that owns every use of real input.
5. Added 12:22: the agent's own browser inside the app must also act without taking his focus, show the same cursor,
   and pass a typist proof (2,000 characters typed elsewhere while the browser fills a form).

## What is done

Only the native layer of part 1, in the sidecar. It compiles and its first calls were tried by hand on Windows 11.

| File | State |
|---|---|
| `tools/agent-screen/src/Act.cs` | NEW. Ops `act`, `probe`, `place`, `presence`, `inject`. Compiles. `act` tried on Notepad only. `probe`, `presence` tried. `place` and `inject` never run. |
| `tools/agent-screen/src/Program.cs` | `Program` is now `partial`; the five ops are in the switch; `windows` takes `minimised: true`; a window says `minimized`; `input` takes `activity: true` (one line per 40 ms when HE touches mouse or keys, by the injected flags); version 0.2.0. |
| `tools/agent-screen/build.cmd` | Compiles `Program.cs` and `Act.cs`, references System.Management (for a process command line). |
| `tools/agent-screen/bin/win-x64/agent-screen.exe` | Rebuilt from the above (90,112 bytes). Matches the committed source. |
| `tools/agent-screen/proof/lab/` | Scratch tools used for the research: `sc.mjs` (a JSON-lines client), `act.mjs` (run actions and compare his cursor and foreground before and after), `quiet.cs` (start a program, push it to the bottom, give the keyboard back if it took it), `giveback.cs`. Build the two `.cs` with the system `csc.exe`. |

Nothing else exists yet: no TypeScript, no tools, no cursor, no lock, no settings, no prompt line, no tests, no
`docs/agent-cursor.md`. The existing unit test `apps/desktop/test/showme-native.test.ts` was NOT re-run after the
sidecar change (it uses a fake sidecar, so it should not care).

## How `act` works (read `Act.cs`, the header says the same)

Request: `{op:"act", hwnd, pid?, action, node? | name?+role?+nth? | x?+y?, text?, key?, dy?, state?, append?, rungs?, waitMs?}`.
`x`,`y` are pixels from the window's top left (the frame `windows` reports). `pid` must still match the window.
Actions: click, double_click, right_click, type, set_value, toggle, select, expand, collapse, scroll, key.

Each rung is tried, then the effect is looked for (element state, the process's windows, the control tree, a
96x64 sample of the window's own picture by PrintWindow). The answer says `rung`, `evidence`, and every rung
`tried`. Nothing changed: `ok:false, reason:"ignored"`. Refusals are errors with a code: `elevated`, `raw_input`,
`own_window`, `no_window`, `no_element`, `disabled`, `minimised`, `bad_request`.

Rungs: `uia:toggle|select|invoke|expand|default|value|range|scroll|contextmenu`, `msg:settext|replacesel`,
`post:mouse|wheel|char|key|key+state|contextmenu`. The CDP rung is meant to live in TypeScript; `probe` gives it the
debug port from the process command line and the page window's rectangle.

## Research findings so far (Windows 11, 125%, only Notepad was reached)

Target: my own Windows 11 Notepad (class `Notepad`, WinUI, edit child `RichEditD2DPT`), started in the background.

| Action | Rung | Result |
|---|---|---|
| type into "Text editor" | `uia:value` | Worked, BUT NOTEPAD TOOK THE FOREGROUND. See below. |
| type, append | `uia:value` | Worked (Notepad was already in front by then, so focus is not proven either way). |
| type | `post:char` (WM_CHAR to the child) | Worked (same caveat). |
| type "" (replace) | `msg:settext` (WM_SETTEXT) | Worked with Notepad in the BACKGROUND, his foreground and cursor unchanged. This is the safe rung for it. |
| click Bold | `uia:toggle` | Worked (caveat as above). |
| click File menu | `uia:invoke` | Worked (caveat as above). |

His cursor never moved in any call (1597,975 before and after).

### The important one: UI Automation can steal focus

`ValuePattern.SetValue` on Windows 11 Notepad's document brought Notepad to the front, over his live Agent window.
The `GiveBack` in `act` (AttachThreadInput to the taker, SetForegroundWindow to his window) ran once straight after
and FAILED; the same calls from a separate process a minute later worked. So:

- UIA patterns are not safe by default. At least `uia:value` on a RichEdit/WinUI document activates the window.
- For typing, `msg:settext` / `msg:replacesel` (classic and RichEdit children) and `post:char` should come BEFORE
  `uia:value` when the target is not already the foreground window. `uia:value` stays first only for windows with no
  edit child of their own (Chromium, where the value pattern is the accessibility API and no window message exists).
  This order is NOT yet in the code: today `type` tries `uia:value` first.
- A focus guard is needed around every rung. I had it written and was about to apply it when stopped:
  a thread that polls `GetForegroundWindow` every 2 to 4 ms during the action and about 180 ms after; the moment the
  foreground belongs to the target's process and did not before, it calls `GiveBack(his, taker)` and keeps trying
  until it holds, timing how long he lost the keyboard. The answer then carries
  `foreground: {taken, givenBack, lostMs, times, tookOn: "<rung>"}`.
- The caller must remember takers: per (process, window class, rung) that took focus, never use that rung there
  again (pass `avoid: ["uia:value"]`; `ActRun.Allowed(family, rung)` was the planned hook). Persist it.
- Starting a program also steals focus. `notepad.exe` started with SW_SHOWNOACTIVATE still came to the front
  (it is a packaged app); `quiet.exe` gave the keyboard back within 50 ms. Proofs should start targets only while he
  is idle, or on the agent desktop.

### Not reached at all

Calculator (UWP), File Explorer, a Win32 dialog, Chrome, an Electron app. Nothing is known yet about which of them
ignore posted input. `post:key+state` (Ctrl/Alt/Shift by joining the target thread's input and SetKeyboardState) is
written and never run. `inject` (SendInput under the lock) is written and never run; it must never be run on his
desktop, only on the agent desktop or with a stub.

## Incidents (be honest in PROOF.md)

1. 12:30: starting my test Notepad took the foreground from his Agent window for under 50 ms (given back).
2. 12:31: `uia:value` on that Notepad took the foreground and it stayed taken for about a minute (two more test
   calls ran with Notepad in front) until I gave it back by hand. Nothing was typed into his windows; all text went
   to my Notepad. His cursor did not move.

## Existing real input in the app (grep done, nothing changed yet)

- `apps/desktop/src/main/dictation/paste.ts`: `keybd_event` Ctrl+V into HIS foreground window for HIS dictation.
  It is his own action. Plan: the lock names it as a user-owned use, it is not agent input.
- `tools/agent-screen/src/Program.cs` `Focus`: SetForegroundWindow with AttachThreadInput, only to hand the
  keyboard back to the window he asked about when the quick chat bar closes. His own action too.
- `tools/agent-screen/proof/send-input.ps1` and `proof.mjs`: a proof kit that moves his real mouse
  (SetCursorPos, mouse_event, keybd_event). Plan: delete the script and the checks that use it.
- `apps/desktop/src/main/browser/browser.ts` about line 2862: `wc.sendInputEvent` key events to the browser's own
  webContents. NOT audited yet (part 5).
- No robotjs, nut.js, SendKeys or SendInput anywhere else. Nothing in `prompt.ts` tells agents to inject input.

## Browser focus stealing (part 5): not started

No file under `main/browser/` was read for this. The old cause is NOT found. Where to look first:
`BrowserWindow.focus()`, `show()`, `moveTop()`, `webContents.focus()` and `sendInputEvent` in `browser.ts`,
`cdp.ts`, `guide.ts`, `guide-host.ts`, `upload.ts`, `vault/browser-vault.ts`; the brief asks for CDP
`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText` plus `Emulation.setFocusEmulationEnabled`
instead of real focus.

## Design I had settled on (not written down anywhere else)

- New folder `apps/desktop/src/main/agent-cursor/`: `surface.ts` (the `AgentSurface` seam; the merged
  `agent-desktop/agent-surface.ts` from `feat/agent-desktop` should become the one seam), `control.ts` (windows, read,
  act, the ladder with the CDP rung, the takers memory), `cdp-rung.ts`, `cursor.ts` (logic, Electron-free, one
  cursor per acting agent keyed by `ctx.owner`), `cursor-page.ts` and `cursor-window.ts` (a second page in the same
  kind of window as `overlay/overlay-window.ts`: transparent, never focusable, `setIgnoreMouseEvents(true)` always,
  registered with `CapturePrivacy` as `'guide'` so it follows `hideGuidesFromCapture`), `input-lock.ts`.
- Tools in `tools/screen-control.ts`, added in `runtime/toolset.ts` `workerTools` beside `screenGuideTools` (so
  helpers get them); `screen_windows` and `screen_read` go in `runtime/read-only.ts`; `screen_act` in
  `vault/guard.ts` so `{{vault:REF}}` works as text. A picture is returned as `[[image:<path>]]` like `browser_look`.
- The cursor follows the window by polling the sidecar's `place` op (bounds, minimised, `shows` at the point).
- Settings (packages/core/src/ipc.ts, main/settings.ts, renderer/views/settings/registry.ts, Settings.tsx beside
  `hideGuidesFromCapture`): `agentCursor` (default true), `agentRealInput` (default FALSE: my decision, stricter
  than the brief, because the real path cannot be proven on his desktop), `agentRealInputIdleSeconds` (default 10).
- Lock: real input only when the ladder and the agent desktop cannot do it, the setting is on, a notice was shown
  (with Not now; any touch of his mouse or keyboard also cancels), and he has been idle. The sidecar's `inject`
  enforces idle, aborts on his input (`Hooks.HisOwn`) and restores cursor and foreground itself.
- Guard for shell commands: refuse SetCursorPos, mouse_event, keybd_event, SendInput, SendKeys, AppActivate,
  pyautogui, pynput, xdotool, AutoHotkey, nircmd in `tools/shell.ts`, `tools/code.ts` AND for plan engines in
  `runtime/sdk-permissions.ts` (the `COMMANDS` branch, before the `free` shortcut), with a message pointing to
  `screen_act`. Plus one line in `runtime/prompt.ts` next to `GUIDED_MODE`.
- A test that greps the source tree for real-input API names and fails for any file outside an allow list.

## Exact next steps

1. In `Act.cs`: add the focus guard and `avoid`, reorder `type` (msg and post before `uia:value` when the target is
   not in front and has an edit child), rebuild with `tools\agent-screen\build.cmd` on Windows, recommit the exe.
2. Finish the research with `proof/lab/act.mjs` on your own Calculator, Explorer window, a Win32 dialog, Chrome with
   `--remote-debugging-port` and an Electron window. Start them only while he is idle. Record per app: rung, focus
   taken or not, what is ignored. Write `docs/agent-cursor.md`.
3. Merge `feat/agent-desktop` (ce34feb), make one seam, delete that branch.
4. TypeScript, tests red first: control and tools, then cursor, then lock, then the browser audit (part 5).
5. Proof in a built test copy, release from merged `devices`, memory pages. All as the original brief says.

## Where things are

- PC clone used for this: `C:\temp\agent-cursor\repo` (LF line endings: `core.autocrlf false`). Scratch: `C:\temp\agent-cursor\lab`.
- Server clone: `impetix:~/repos/agent-cursor` on `devices` e000b10, untouched, no install run, nothing running.
- Nothing of mine is running on the PC: the test Notepad is closed, no sidecar, no test copy, no browser tab.
- Project memory was NOT updated (nothing shipped).
