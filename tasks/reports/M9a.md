# M9a report: the agent's browser (main process)

## Built

- `apps/desktop/src/main/browser/url-policy.ts`: `checkBrowserUrl` and `privateHostReason`.
  Only http(s) get through, with https added to a bare domain. `file:`, `chrome:`, `devtools:`,
  `javascript:`, `data:` and `about:` are refused. Loopback, private IPv4, link-local, carrier,
  IPv6 local ranges, `.local`/`.internal`/`.lan`/`.home.arpa` and single-label machine names are
  refused unless the address came from the person (`personTyped`).
- `apps/desktop/src/main/browser/outline.ts`: every page helper as a plain JavaScript string:
  `outline`, `read`, `click`, `type`, `scroll`, `waitFor`, `upload`, plus the parsers and
  `formatOutline`. The page keeps a numbered element registry in an isolated world so a later
  `click(3)` means the element the model saw at `[3]`. The outline lists visible links, buttons,
  inputs, selects and ARIA controls, visible headings, the URL and title, and a `NOTE:` line for
  captchas, verification codes and sign-in forms. Uploads use a `DataTransfer` and a native value
  setter, no debugger protocol.
- `apps/desktop/src/main/browser/browser.ts`: `AgentBrowser`, one `WebContentsView` per tab,
  partition `persist:agent-browser`, `contextIsolation` on, no preload, sandbox on, background
  throttling off so timers keep running while the panel is hidden. Popups become tabs (five at
  most, a sixth is refused with a plain reason). Downloads save into a per-run temporary folder and
  are reported as paths in the next outline. `open`, `snapshot`, `read`, `click`, `type`, `press`,
  `scroll`, `waitFor`, `back`, `screenshot`, `upload`, `setAgentDriving`, `hasPage`, plus the
  renderer side: `setBounds`, `state`, `back`, `reload`, `selectTab`, `closeTab`, `takeOver`,
  `giveBack`, `openInSystem`. While the agent drives, `before-input-event` blocks the person's keys
  (except keys the agent sends itself) and injected CSS blocks the mouse. Taking over removes both.
- `apps/desktop/src/main/tools/browser.ts`: the twelve tools from `BrowserTools.kt`, adapted to
  indexes: `browser_open`, `browser_look`, `browser_read`, `browser_click`, `browser_type`,
  `browser_press_key`, `browser_scroll`, `browser_wait_for`, `browser_back`, `browser_upload`,
  `browser_handoff`, `browser_show_user`. Arguments are validated with plain-words results, not
  throws.
- `packages/core/src/ipc.ts`: additive `BrowserBounds`, `BrowserTab`, `BrowserState` and the
  `browser` group (`setBounds`, `state`, `back`, `reload`, `selectTab`, `closeTab`, `takeOver`,
  `giveBack`, `openInSystem`, `onState`). Preload, channels (`agent:browser.*` plus
  `agent:evt:browser.state`), `registerIpc` (with bounds validation) and the mock bridge are all
  updated. The Mock bridge keeps the SkyHop demo tab and a live-ish state so M9b has something to
  render.
- `runtime/toolset.ts`: one appended line registers the browser group. The main process builds the
  real `AgentBrowser` after the window exists and threads it into the runner and IPC.
- Electron smoke now opens a `data:` page in the agent browser, runs the real outline helper over
  it, prints `BROWSER OK`, then the normal `SMOKE OK`.

## Tests

Thirty-three new tests (196 in the repo, all green):

- `browser-url-policy.test.ts` (10): schemes, bare domains, credentials, loopback, private ranges,
  IPv6 mapped addresses, local names, the person-typed exception and still-blocked schemes.
- `browser-outline.test.ts` (10): a real Chromium from `playwright-core` against a local HTTP
  fixture. Visible/hidden elements, headings, stable numbering, click, type with input events, read
  by index and selector, missing numbers, wait and timeout, scroll, captcha note, file upload and
  the formatted outline.
- `browser-tools.test.ts` (11): every tool registered, URL and index validation, read targets,
  key list, scroll direction, wait clamp, the full handoff flow (question, options, notification,
  control handed over and returned), skip and absent cases, screenshots and upload approval.
- `ipc-contract.test.ts` (+2): the browser group is reachable, bounds round trip, controls are
  driven, nonsense bounds and tab ids are rejected.

## Deviations and decisions

- `browser_handoff` uses the existing question card (`ctx.ask`) with "Done, carry on" and "Skip",
  because `ToolContext` has no approval card with custom button labels. This is the same shape as
  the Kotlin `BrowserHandoffTool`, and it still suspends the tool and gives the person control.
- `browser_upload` asks for approval before the file leaves the computer. PLAN.md 5.3 says a tool
  that sends anything must call `ctx.approve`; the Kotlin tool did not, so this is a deliberate
  security deviation.
- The upload helper injects a `File` through `DataTransfer` and the native value setter. It works
  with ordinary file inputs (proved in Chromium) and does not use the debugger, but a site with a
  custom picker that never reads `input.files` may still refuse it.
- The URL policy checks literals and local names synchronously. It does not resolve DNS before
  navigation, so a hostile public DNS name that answers with a private address could still be
  reached. `web_fetch` has that DNS check; the browser engine owns redirects and connections, so
  pinning would need Chromium's network layer. Recorded here rather than silently claimed.
- The smoke uses a dedicated `smokeOutline` method that loads a `data:` URL directly, because
  `browser_open` must refuse anything that is not http(s). It sets a temporary 480x360 visible
  rectangle first, because a zero-sized hidden view reports zero-sized headings.

## For M9b (renderer)

- Report the panel rectangle with `window.agent.browser.setBounds`; send `visible: false` when the
  route is not Chat or the panel is collapsed.
- Subscribe to `browser.onState`; use `state.agentActive` for the "Nova is here" pill and
  `state.needsUser`/`handoffReason` for the "your agent needs a hand" banner. `state.tabs` is the
  tab strip; `selectTab` and `closeTab` take a tab id.
- "Take over" should call `browser.takeOver()`; handing back should call `browser.giveBack()`.
  `openInSystem()` opens the current page in the person's own browser.
- In the mock bridge the SkyHop tab is already present and the state methods mutate a local copy,
  so the panel interactions can be built and screenshotted before Electron is involved.
- No new dependencies.
