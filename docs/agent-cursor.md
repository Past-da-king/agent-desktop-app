# Agent cursor and no-real-input control (11 Nov 2026)

Rule (Ayanda, 11 Nov 2026): the agent never moves his real pointer, sends keys to his foreground or takes window focus.
Handover from the first lead: `docs/agent-cursor-handover.md` (research, incidents). Own desktop: `docs/agent-desktop.md`.

## The ladder (screen_act; every action verified; "ignored" is reported, never faked)
1. Window messages for text: WM_SETTEXT / EM_REPLACESEL, then WM_CHAR to the child HWND. UIA value is NOT first: it brought
   Notepad to the front for a minute. UIA value stays first only for windows with no edit child (Chromium).
2. UI Automation patterns (invoke, toggle, select, expand, scroll), each wrapped in a focus guard.
3. CDP for Chromium and Electron (Input.dispatch*, insertText), no OS focus.
4. Other posted input (PostMessage mouse, key, key+state) to the child HWND, never activating.
5. The agent's own desktop (`tools/agent-desktop`, CreateDesktop, never SwitchDesktop) for apps that ignore posted input.
   Capture is black for Chromium, Electron and GPU apps: those stay on rung 3.
6. Last resort, real input under ONE lock (`input-lock.ts`): setting `agentRealInput` default OFF, he is told first, only when
   idle (default 10 s), aborts when his own input appears (injected flags), restores cursor and foreground.

## Tools
`screen_windows`, `screen_read` (UI tree and off-screen PrintWindow picture; read-only list), `screen_act` (in the vault guard so a
vault [vault:vercel-recovery-past952.token] works as text). In `runtime/toolset.ts` beside `screenGuideTools`. Picture as `[[image:path]]`.

## Agent cursor
Branded cursor and step label in the click-through, never-focusable overlay; glides to the target, pulses on click; one per
running agent (key `ctx.owner`); setting `agentCursor` default on; follows `hideGuidesFromCapture`. Shown for browser actions too.

## Own browser (part 5)
No `BrowserWindow.focus`, activating `show`, `moveTop`, `webContents.focus`, SetForegroundWindow or OS input from browser tools,
guide code or vault fill. Input goes in by CDP Input.dispatchMouseEvent, dispatchKeyEvent, insertText, with
Emulation.setFocusEmulationEnabled where a page needs focus. `wc.sendInputEvent` (browser.ts ~2862) must be audited.

## Guards
One line in `runtime/prompt.ts` next to GUIDED_MODE. Shell guard in `tools/shell.ts`, `tools/code.ts` and
`runtime/sdk-permissions.ts` (COMMANDS branch, before the free shortcut) refusing SetCursorPos, mouse_event, keybd_event, SendInput,
SendKeys, AppActivate, pyautogui, pynput, xdotool, AutoHotkey, nircmd, pointing to `screen_act`. A test greps the tree for real-input
API names outside an allow list (dictation/paste.ts and the sidecar Focus hand-back are his own actions).

## Own desktop: Watch, Take over, Give back
Wired as rung 5 via the one `AgentSurface` seam. The viewer UI is built only if it fits this release; else listed as open.

## Notes to builders
- Branch `feat/agent-cursor` already contains the merge of `feat/agent-desktop`. `git pull --rebase` before every push; small commits, push often.
- Windows-input builder owns: tools/agent-screen (Act.cs focus guard, `avoid`, reorder `type` per the ladder; rebuild with build.cmd on
  Windows, recommit the exe), apps/desktop/src/main/agent-cursor/{control,cdp-rung,input-lock}.ts, tools/screen-control.ts, toolset,
  read-only, vault guard, prompt line, shell guard, the grep test, the lock, settings `agentRealInput`, `inputLockIdleSeconds`.
- Cursor and browser builder owns: agent-cursor/{cursor,cursor-page,cursor-window}.ts, setting `agentCursor` (ipc.ts, settings.ts,
  registry.ts, Settings.tsx), main/browser/* and guide*.ts audit and CDP input, browser tool cursor events.
- Interface between them: `cursor.ts` exports `agentCursor.show({owner, rect, label})`, `.click(owner)`, `.hide(owner)`; `control.ts` calls it with
  window rects from the sidecar `place` op. Builder A may stub it until B lands; do not duplicate.
- Focus guard rule: read GetForegroundWindow before an action; if it changed, SetForegroundWindow back to HIS window (the one allowed use,
  inside the guard), report `foreground.taken`, and remember (process, class, rung) as a taker so it is avoided.
- Test apps: start minimised or SW_SHOWNOACTIVATE, only while he is idle; never run `inject` on his desktop.
- I (integration lead) own the agent-desktop wiring (rung 5), release, proof and memory. Do not bump the version.
