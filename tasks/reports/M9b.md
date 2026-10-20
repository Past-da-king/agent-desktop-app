# M9b report: the agent browser panel (renderer)

## What I built

The Chat docked panel is now a live browser panel instead of a static mock card.

- `shell/Panel.tsx` draws the panel chrome: a read-only URL bar, Back and Reload, a tab strip with
  select and close, a status pill that says "<agent name> is here" (or "<agent name> needs you"
  while a handoff is open), Take over / Give back, and "Open in my browser".
- The page itself is the main process's `WebContentsView`; the renderer reserves a rectangle
  (`.br-view`) and reports it through `window.agent.browser.setBounds`. The report is debounced by
  80 ms, follows a `ResizeObserver` and window resizes, and is sent hidden on unmount, so leaving
  Chat or collapsing the panel removes the native view.
- The panel is collapsible. Collapsed it becomes a 56px strip with a reopen button. The width is
  dragged by a splitter between 320 and 560 px, also adjustable with the arrow keys, and remembered
  in localStorage (`agent.browser.panel`). Double-click resets it to 380.
- Empty state: "The agent's browser opens here when it needs one", with an action that focuses the
  composer. Loading the browser state is a short silent wait, not a false empty state.
- The mock bridge keeps the SkyHop demo. Its flight data now lives in `bridge/seed.ts`
  (`skyHopDemo`) and the panel renders it only when `agent.platform === 'web'`. Electron paints the
  real page over that slot instead.
- `browser_handoff` questions are drawn as a dedicated handoff card with "Done, carry on" and
  "Skip" buttons. The panel also tells the person the page is theirs and to finish in the chat.

Pure logic lives in `lib/panel.ts` (width clamping, preference read/write, rectangle rounding and
the URL display), unit tested in `apps/desktop/test/browser-panel.test.ts` (9 tests).

## What I could not finish

Nothing in the brief was skipped. Two honest notes:

- The live Electron path cannot be exercised by the browser screenshot harness. The panel is
  proven visually on the mock bridge; the native view placement is covered by the M9a smoke test
  (`BROWSER OK`) and by the bounds arithmetic unit tests. Claude should still confirm the view sits
  exactly over the slot on Windows, especially at a non-100% display scale.
- In the mock bridge, Back and Reload are no-ops because there is only one fake page. They are real
  IPC calls in Electron.

## What the next milestone must know

- `AgentApi.browser` already had every method M9b needed; no contract change was made.
- `--panel-w` is now the CSS variable that sizes the third grid column. Any new shell work should
  keep `.shell.panel`, `.shell.panel-collapsed` and the 1180px collapse rules in step.
- The native page is above the renderer, so nothing rendered inside `.br-view` can appear on top of
  a real page. Status such as the "is here" pill therefore lives in the chrome above the slot, not
  as a DOM overlay, which is the one deliberate difference from the mockup.
