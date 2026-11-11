# Agent cursor (UI) and the browser without focus (11 Nov 2026)

Part of docs/agent-cursor.md. Builder: cursor and browser UI. Tests: apps/desktop/test/agent-cursor.test.ts. Proof kit:
apps/desktop/proof/agent-cursor-ui/harness.ts (own Electron copy, own user data, never injects input).

## The cursor
- `overlay/agent-cursor.ts` logic (Electron-free, API in its header), `agent-cursor-page.ts` the drawing (brand look only),
  `agent-cursor-window.ts` the windows (transparent, `focusable:false`, `showInactive`, `setIgnoreMouseEvents(true)`, registered with
  CapturePrivacy as `guide`, so it follows hideGuidesFromCapture).
- With an owner (the app window): a child window of it, covering the page area only; hides and minimises with the app. Without: always on
  top, one per display. One cursor per agent id (browserOwner / ctx.owner), each with its own label; with more than one on screen the
  label also names the agent. A cursor nobody touches for 20 s goes; `onRunEnded` removes a run's cursor at once.
- Door for the screen tools: `agent-cursor/cursor.ts` `agentCursor.show({owner, rect | locate, label})`, `.click`, `.label`, `.hide`. Set
  in index.ts. `locate` is read 5 times a second: return `{at, visible}` from the sidecar `place` op (visible false when minimised or
  covered; null hides).
- Setting `agentCursor` (default on), Settings > Privacy, row above the guide switch. Off: every call is a no-op and the windows are closed.
- Browser: `browser/agent-cursor-link.ts` turns the action's page point into screen DIPs through the view and window
  (guide-geometry), labels the step (never the typed text), hides when the tab is not in front, covered or the window minimised.
  `browser.ts` `showCursor` runs at the start of every act (click, type, select, hover, scroll, drag, hold, press, point actions); a click
  waits 300 ms for the glide, then pulses. Not done: browser_upload, vault_fill, vault_login and the guide do not call it yet; in-page
  drawing when the overlay is off was not built (the window cursor is used either way; it is visible to a screen share only when
  hideGuidesFromCapture is off).

## The old focus-stealing cause (browser)
1. A page opened by an agent's click (sign-in popup via window.open) was shown with `child.show()` and `child.focus()`: a real
   operating-system focus steal. Now: shown with `showInactive()` and never focused, unless his OWN click opened it.
2. A debugger click into the <webview> let Chromium move keyboard focus into the guest, taking it from the chat message box of the
   same window. Now: `Emulation.setFocusEmulationEnabled` on every agent tab (the page believes it has focus, never asks for it) and
   `focus-keeper.ts` gives the keyboard back to the message box if it still moved (only when the app window is already his foreground).
3. Audit result: no `webContents.focus()`, `BrowserWindow.focus()`, `moveTop`, `Page.bringToFront`, SetForegroundWindow, robotjs or OS
   input in main/browser, browser-vault, tools/browser-pro or tools/vault. The only focus calls left: opening devtools (his action), the
   popup his own click opened, and the keeper. Test `agent-cursor.test.ts` fails if another one appears. Input already went in by CDP
   (cdp.ts). Left as is: `pressKey` (webContents.sendInputEvent) is only the fallback when the debugger is busy; it posts to the page,
   not to the OS.
- Not proven on the real app: the typist proof (the lead's job) and a minimised-window run.
