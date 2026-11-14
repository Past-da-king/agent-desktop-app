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


## Browser focus (0.2.129): why his typing was interrupted, and what stops it

Measured 11 Nov 2026 in a real Windows copy of the app (Electron 44), the chat box focused and typed into at 6 characters a
second while the agent drove a form in its own browser. Harness: `tools/focus-proof/` (run.ps1) with the probe
`main/browser/focus-probe.ts` (env AGENT_FOCUS_PROBE; never set in normal use).

**The cause.** The agent's pages are `<webview>` guests in the same focus tree as the chat box. The debugger sends keys and text
to the window's focused widget, and a press moves that focus into the page. Result: the chat box loses its caret, and he and
the agent share one keyboard. Chromium has no switch for it (the injector and the page's frame focus do it inside the browser
process; `Emulation.setFocusEmulationEnabled`, `inert`, `visibility:hidden` on the `<webview>` change nothing).

| Agent tool | Debugger call | Moves the keyboard to the page (0.2.126) | Why |
|---|---|---|---|
| browser_open, snapshot, read, eval, view | Runtime.evaluate, Page.navigate, Emulation.* | no | page scripts and navigation never ask for focus; a page script `el.focus()` is quiet too |
| browser_look | Page.captureScreenshot, capturePage | no | |
| browser_scroll, act scroll, act hover | Input.dispatchMouseEvent mouseWheel, mouseMoved | no | only a press takes focus |
| act click, check, uncheck, browser_click, select (custom list), double, right, hold, drag | Input.dispatchMouseEvent mousePressed (also Input.dispatchTouchEvent, Input.synthesizeTapGesture) | **yes** | the press focuses the page; measured on a click on empty body too |
| act type, browser_type | the press above, then Input.insertText | **yes, for the whole action** | and Input.insertText goes to the window's focused widget: with no press first it types into HIS chat box |
| act press, browser_press_key | Input.dispatchKeyEvent | **yes, and worse** | keys go to whoever holds the keyboard in the window: with the page not focused, Enter or Space lands in his chat box (Enter sends his message); Tab moves his focus |
| browser_upload | DOM.setFileInputFiles, file chooser, trusted click | click only | covered by the burst below |
| vault_fill, vault_login | page scripts through the debugger link (no Input.*) | no | read from `vault/`; not run in the loop |
| browser_guide | his own clicks; overlay windows | no | read from `guide*.ts`; not run in the loop |
| popup an agent click opened | showInactive | no | 0.2.126 |

Window events do not show it: the app page's WebContents never emits blur and the guest never emits focus; only the page's own
`document.hasFocus()` and `activeElement` see it. The 0.2.126 `focus-keeper` asked `webContents.isFocused()` and ran only
around debugger input; in the test copy it never gave the keyboard back (the box ended with 17 of 413 characters).

**The fix (0.2.129), in the order of the principle.**
1. Prevented: typing no longer presses. The field takes the page's focus by script and the text goes in with
   `webContents.insertText` (to that page's focused field, whoever holds the window's keyboard). Tab and Shift+Tab move the page's
   focus by script (`tabScript`). Nothing else on the table above moved it.
2. What still has to press or send keys is a burst (`FocusGuard.burst`, `focus-keeper.ts`): the page is given the keyboard on
   purpose (`wc.focus()`), the click or keys go in, and the keyboard goes back to the exact element he was in the moment the
   burst ends, never in the middle (so a key can never land in his message). The press-to-release gap is 12 ms.
3. His own keys that reach the page during a burst are kept from it (the existing `before-input-event` hook) and typed into the
   chat box, in order, after it has the keyboard back (`swallow`, `keyToEvents`). Keys the agent sends itself pass.
4. Safety net: every `Input.*` command goes through `guardDebugger`; any that takes the keyboard outside a burst is given back
   within a tick. Each give-back is logged ("keyboard given back to the chat") so a path that still takes it shows up.
5. Never when he is in another app (it checks the app is the foreground window first), so it cannot bring the app forward.

What is not fixed at the source: a real press (click, key) still moves the keyboard for the length of a burst (about 20 to 40 ms),
because the page is a guest in the window's focus tree. Removing that needs the agent's page to be a separate native view
(WebContentsView) instead of a `<webview>`, a larger change that was not made. His own clicks into the page still focus it
normally. Numbers: `Downloads/agent/proof-focus-0.2.129/PROOF.md`.
