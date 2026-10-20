# Agent Desktop: the plan

Owner: Ayanda. Written 20 Oct 2026. Implemented by DeepSeek V4.1 Flash (OpenCode), one milestone at a time.
Reviewed and finished by Claude at the end (see "Finishing pass" at the bottom).

## 1. What we are building

The Agent app (Android, package `com.past9.phoneaos`) as a full desktop application for Windows first, then macOS and Linux.
The user sees the same agent, the same memory, the same chat and the same design language as on the phone, but with a real
desktop layout: a left rail, a big rounded main sheet, a docked panel, a command palette, a tray icon, a global
Quick Ask hotkey, drag-and-drop files.

The UI to build is already designed and clickable: **`design/mockup.html`** (single file, vanilla JS). Screenshots of every
screen at 1440 / 1024 / 390, light and dark, are in `design/shots/`. The job is to port that mockup into a real React app
and wire it to a real agent runtime. **Do not redesign it. Port it.** Where the mockup invents something that does not
exist yet, section 11 says what to do.

It is a product for other people, not only for Ayanda. Nothing may be hardcoded to his accounts, servers or machines.

## 2. Decisions (already made, do not re-open)

| Topic | Decision | Why |
|---|---|---|
| Shell | Electron (version 38 or newer) | Built-in Chromium gives the agent's own browser, the "learned apps" JS-in-page, and a live browser panel almost for free. |
| UI | React 18 + TypeScript + Vite via `electron-vite` | The mockup is HTML/CSS/JS; the port to React is mechanical. |
| Styling | One global stylesheet lifted from the mockup, CSS custom properties for tokens | The mockup's CSS is the design. Do not switch to Tailwind or CSS-in-JS. |
| State | Zustand (renderer) | Small, no boilerplate. |
| Agent runtime | TypeScript in `@agent/core`, runs in the Electron main process | Port of the Kotlin `AgentLoop`, providers, repair, trim. Pure Node, testable without Electron. |
| Local DB | `node:sqlite` (`DatabaseSync`), built into Node 22.5+/Electron 38+ | No native module to rebuild, so tests and Electron use the same code. |
| Sync | The existing zero-framework sync service (`reference/kotlin-sync-service/Main.kt`) and the HLC last-writer-wins protocol | Already built, data-blind, multi-tenant. Not changed by this project. |
| Secrets | Electron `safeStorage` (Windows Credential Manager / Keychain / libsecret) | API key and sync token never touch the renderer or `settings.json`. |
| Providers | Anthropic, OpenAI-compatible (OpenAI, Gemini, DeepSeek, OpenCode Go/Zen, OpenRouter, custom) | Same as the phone. |
| Tests | vitest for logic. Playwright (library only, with the Chromium already on this machine) for screenshots. | See section 8. |

Not in v1 (do not build): subscription sign-in (Claude/ChatGPT plans), voice, the phone "cards" feature, Composio
connected apps, SSH machines, notification reading, token streaming. The UI shows these as "Coming soon" where the
mockup shows them (section 11).

## 3. Repo layout

```
agent-desktop-app/
  AGENTS.md            rules for you
  PLAN.md              this file
  tasks/M0.md ...      one file per milestone; tasks/reports/ is where you write reports
  scripts/             gate.sh (the judge), shoot.mjs, fake-sync-server.mjs, run-milestones.sh. NOT yours to edit.
  design/              mockup.html and screenshots (read-only reference)
  reference/           Kotlin sources the TypeScript mirrors (read-only reference)
  package.json         npm workspaces: packages/*, apps/*
  tsconfig.base.json
  packages/core/       @agent/core: pure TypeScript, no Electron, no DOM. Runs on Node 22+.
    src/ipc.ts           THE CONTRACT (already written; extend additively only)
    src/model.ts         Msg, Block, ToolSpec, Tool, ToolContext, LlmProvider ...
    src/http-policy.ts
    src/providers/anthropic.ts, openai-compat.ts, factory.ts, catalog.ts
    src/repair.ts, trim.ts, loop.ts
    src/sync/hlc.ts, change.ts, client.ts, engine.ts, store.ts
    src/index.ts         re-exports
    test/*.test.ts
  apps/desktop/
    electron.vite.config.ts
    src/main/            Electron main process (Node)
      index.ts             app lifecycle, windows, single-instance lock
      db.ts                node:sqlite Store (implements SyncStore)
      settings.ts, secrets.ts
      ipc.ts               registers every ipcMain handler for AgentApi
      runtime/             agent runtime (prompt, tools, runner, routines, helpers)
      tools/               one file per group of tools
      tray.ts, hotkey.ts, notify.ts
      browser/             the agent's browser (M9)
    src/preload/index.ts   builds window.agent over ipcRenderer
    src/renderer/
      index.html, main.tsx, App.tsx
      styles/              tokens.css, base.css, components.css, views.css (lifted from the mockup)
      ui/                  Icon.tsx, Mascot.tsx, Wave.tsx, Ring.tsx, Button.tsx, Field.tsx, Segmented.tsx ...
      shell/               TitleBar.tsx, Rail.tsx, Sheet.tsx, Panel.tsx, Palette.tsx, QuickAsk.tsx
      views/               Home.tsx, Chat.tsx, Tasks.tsx, Memory.tsx, Routines.tsx, Connections.tsx, Settings.tsx
      onboarding/          SignIn.tsx, Sync.tsx, Ai.tsx, Style.tsx
      state/               stores (zustand)
      bridge/index.ts      picks window.agent if present, else the mock
      bridge/mock.ts, bridge/seed.ts   in-memory AgentApi with the mockup's demo data
```

## 4. Data model and sync (get this right; everything else sits on it)

### 4.1 One generic table
All synced rows live in one table so the sync code never knows the shape of a row:

```sql
CREATE TABLE rows(
  entity  TEXT NOT NULL,        -- 'chat_item' | 'turn' | 'memory' | 'goal' | 'task' | 'trigger'
  cid     TEXT NOT NULL,        -- uuid, the row id everywhere (renderer sees it as `id`)
  stamp   TEXT NOT NULL,        -- HLC stamp "<millis>-<counter>-<device>"
  deleted INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,        -- JSON of the row WITHOUT id
  PRIMARY KEY(entity, cid)
);
CREATE INDEX rows_stamp ON rows(stamp);
CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);   -- device_id, push_mark, cursor
```

`payload` field names are exactly those of the interfaces in `packages/core/src/ipc.ts` (`ChatItem`, `MemoryRow`, ...)
minus `id`. `createdAt` and `updatedAt` are epoch milliseconds. `TaskRow.goalId` holds a goal's cid (string).
Deletes are tombstones (`deleted=1`), never removed, so a delete on one device is not undone by a stale copy.

### 4.2 The Hybrid Logical Clock (port `reference/kotlin-shared/sync/Hlc.kt` exactly)
Stamp = `<millis>-<counter>-<deviceId>`. Compare millis, then counter (numeric), then device (string). `now()` moves strictly
forward; `observe(remote)` folds a remote stamp in so the next local stamp is greater. Remote stamps with our own device id are
skipped on apply (our own echo). `deviceId` is a UUID generated once and kept in `kv`.

### 4.3 The protocol (port `reference/kotlin-shared/sync/*.kt`; server is `reference/kotlin-sync-service/Main.kt`)
```
POST /v1/auth/register   {email, password>=6}            -> {userId, token}        409 if taken
POST /v1/auth/login      {email, password}               -> {userId, token}        401 if wrong
POST /v1/sync/push       Bearer; {device, changes:[Change]} -> {cursor}
GET  /v1/sync/pull?since=N[&wait=S][&entity=E]  Bearer   -> {changes:[Change+seq], cursor}
GET  /health
Change = {entity, id, deleted, stamp, payload}           (server adds seq)
```
Errors come back as `{error:{message}}`. `wait` makes pull a long-poll (max 55 s). Use it: after the first pass, the engine
loops `pull(since, wait=25)` so a change made on the phone shows up on the desktop within about a second. Push after every
local write (debounced 300 ms), and also on a 20 s timer as a safety net.

Engine pass: (1) `pending = store.localChanges(pushMark)`; if any, push them, set pushMark to the max stamp pushed;
(2) `pull(cursor)`; if any, `store.applyRemote(changes)`, notify the UI; (3) `setCursor`. Serialise passes with a mutex.
Apply rule (last writer wins): for each remote change, `hlc.observe(stamp)`; if a local row exists with stamp >= remote
stamp, ignore it; otherwise overwrite payload, stamp, deleted.

Compat note: the phone app does NOT implement this protocol yet (its Room database has integer ids). A separate piece of
work (section 12) adds a phone-side adapter. Until then the desktop works fully standalone and syncs with any other
desktop. Do not change the wire format to suit the phone; the phone will adapt to this.

### 4.4 Server URL
`Settings.syncUrl`. Empty by default. Sign-in shows an "Advanced" disclosure with a "Server address" field. A build may
pre-fill it from the environment variable `AGENT_SYNC_URL` at build time (read through `import.meta.env`/`process.env`),
but there is no default in the source. If it is empty, the sign-in step explains it and offers "Use this computer only".

## 5. The agent runtime (`@agent/core` + `apps/desktop/src/main/runtime`)

Port, do not reinvent. Read the Kotlin first (`reference/kotlin-shared/agent/*.kt`).

- `model.ts`: `Role`, `Block` (`text | tool_call | tool_result | reasoning | image`), `Msg`, `ToolSpec`, `Completion`,
  `Usage`, `ProviderException(status, retryable)`, `LlmProvider.complete(system, messages, tools, model, maxTokens)`.
  JSON (de)serialisation of `Msg` must be byte-compatible with Kotlin's `Msg.toJson` (`{"role":"USER","blocks":[{"t":"text",...}]}`)
  because `turn` rows may later be shared with the phone.
- `providers/anthropic.ts`: Anthropic Messages API (`x-api-key`, `anthropic-version: 2023-06-01`).
- `providers/openai-compat.ts`: Chat Completions with tools; `reasoning_content` echo; Gemini `thought_signature` handling;
  extra body fields and headers; retries (3 attempts, 1.5 s * n back-off on 429/5xx/network, not on other 4xx).
- `providers/catalog.ts`: the provider list (id, label, default model, base URL, key hint) from `reference/kotlin-shared/data/Settings.kt`.
- `http-policy.ts`: https required; http only for loopback or when the user opted in.
- `repair.ts`, `trim.ts`: exact ports (`Repair.repair`, `Repair.flatten`, `Trim.fit` with BUDGET 350000, KEEP_RECENT 8).
- `loop.ts`: `AgentLoop.run(system, history, ctx, hooks)` exactly as the Kotlin: steer inbox read before each step, `Trim.fit`,
  one repair-and-retry on a 400 mentioning "tool", sequential tool execution, 24000-char result clip, unknown tool and
  thrown errors become error results, `[[image:/path]]` markers become image blocks, step cap (default unlimited) and abort via `AbortSignal`.
- `ToolContext`: `agentLabel`, `activity(text, meta) -> id`, `updateActivity`, `ask(question, options) -> Promise<string|null>`,
  `approve(summary, details) -> Promise<boolean>`, `notify(title, body)`, `signal: AbortSignal`.

### 5.1 Runner (main process, `runtime/runner.ts`)
One conversation, one main line. `runner.send(text, attachments)`: insert the user `chat_item`; if a run is active, queue the
message and merge it into the active run through the steer inbox (v1 has no branching); else start a run: build the system
prompt, load `turn` rows for thread "main" into history (repair + trim), run `AgentLoop`, persist each appended message as a
`turn` row (`onAppend`), render events into `chat_item` rows (kind `activity` per tool call with `meta` JSON
`{tool, status:'running'|'done'|'error', summary}`, kind `agent` for assistant text), and emit `ChatEvent`s.
Question cards (kind `question`, meta `{options, answer}`) and approval cards (kind `approval`, meta `{summary, details, decision}`)
suspend the tool until `chat.answer` / `chat.decide` arrives. On app restart, pending cards are re-armed or marked expired.
`chat.stop()` aborts the signal; the run ends with a notice row "Stopped".

### 5.2 System prompt
Port the MAIN prompt from `reference/phone/AgentRuntime.kt` (`systemPrompt`, from line ~272), keeping its voice and rules, with
these changes: it lives on the user's computer (Windows/macOS/Linux, say which from `process.platform`), not an Android phone;
drop everything about phone permissions, Composio, machines, cards, notifications, voice notes; drop helper/branch text until
M10 adds it; keep: name lines, current date and timezone, ASSUME YOU ALREADY KNOW (search memory first), memory-as-wiki
rules with `[[Name]]` links, to-do rules, goals/tasks, routines, STYLE (TLDR, no emoji, no em dashes), pinned and recalled
memories, open goals and tasks. `Recall.rank(text, rows, n)`: lowercase word overlap score (title x3, topics x2, body x1),
ties by recency, top n.

### 5.3 Tools
Spec `{name, description, schema}` copied from the Kotlin tools in `reference/phone/tools/*.kt` where one exists. v1 set:
`now`, `memory_search`, `memory_get`, `memory_save`, `memory_update`, `task_add`, `task_list`, `task_update`, `goal_create`,
`ask_user`, `request_approval`, `notify_user`, `web_fetch`, `report`, `routine_create`, `routine_list`, `routine_delete` (M7),
`files_*`, `shell_run`, `run_code` (M8), `browser_*` (M9), `delegate`/`helper_*` (M10).
Every tool that changes the outside world (writes a file outside a granted folder, runs a shell command, sends anything) calls
`ctx.approve` first. Tools never throw to the loop for expected failures; they return a plain-words result string.

## 6. The UI port (`design/mockup.html`)

The mockup is one file. Port it view by view. Line numbers (approximate) in `design/mockup.html`:

| Part | Lines | Becomes |
|---|---|---|
| CSS tokens, light/dark | 6-76 | `styles/tokens.css` |
| window, type, buttons, fields | 77-156 | `styles/base.css` |
| onboarding CSS | 157-206 | `styles/onboarding.css` |
| shell, home, chat, tasks/memory/routines/connections/prefs, overlays CSS | 207-443 | `styles/shell.css`, `styles/views.css` |
| phone-width rules (<=820px) and 1180px collapse | 444-500 | `styles/responsive.css` |
| icons `I` | 518-567 | `ui/Icon.tsx` (keep the SVG paths) |
| mascots (polar/superellipse path generators, SMIL morph) | 569-607 | `ui/Mascot.tsx` |
| wave, ring, QR | 609-627 | `ui/Wave.tsx`, `ui/Ring.tsx`, `ui/Qr.tsx` (QR is decorative only) |
| accents | 629-650 | `state/theme.ts` (inline CSS variable override of `--primary`, `--on-primary`, `--pc`, `--on-pc`) |
| title bar | 693-706 | `shell/TitleBar.tsx` (REAL window controls via `window.agent.window`; frameless window) |
| onboarding (signin, sync, ai, style) | 707-794 | `onboarding/*.tsx` |
| shell + nav + panel | 795-816 | `shell/*.tsx` |
| Home | 817-853 | `views/Home.tsx` |
| Chat | 854-907 | `views/Chat.tsx` + `shell/Panel.tsx` (docked right panel, Chat only) |
| Tasks | 908-923 | `views/Tasks.tsx` |
| Memory | 924-952 | `views/Memory.tsx` |
| Routines | 953-962 | `views/Routines.tsx` |
| Connections | 963-988 | `views/Connections.tsx` |
| Settings | 989-1015 | `views/Settings.tsx` |
| palette + quick ask | 1016-1046 | `shell/Palette.tsx`, `shell/QuickAsk.tsx` |
| events/keyboard | 1072-1137 | handlers in the components, plus `state/keys.ts` for Ctrl+K etc. |

Rules for the port:
1. The class names, tokens, sizes and spacing in the CSS are kept verbatim. If you change a value, you are redesigning. Do not.
2. Components, not template strings. No `dangerouslySetInnerHTML` except for the mascot SVG path data you generate yourself.
3. Everything the mockup shows as demo data (Sam Dlamini, Nova, SkyHop, etc.) lives ONLY in `bridge/seed.ts` and is shown
   only by the mock bridge. The real app starts empty and shows the empty states in section 6.1.
4. Light and dark follow `Settings.theme` (`system` uses `prefers-color-scheme`); set `data-theme` on `<html>` exactly as the mockup does.
5. Responsive: at <= 1180px the rail collapses to icons; at <= 820px the phone layout with the floating pill nav appears.
   Both are in the mockup CSS already. Tablet widths (768-1100) must look like a desktop layout, never a stretched phone.
6. Motion: spring-ish transitions use the `linear()` easing from the mockup with its cubic-bezier fallback; respect `prefers-reduced-motion`.
7. Keyboard: Ctrl/Cmd+K palette, Ctrl/Cmd+N new chat, Ctrl/Cmd+, settings, Esc closes overlays, Enter sends, Shift+Enter newline.
8. Accessibility: real `<button>`s, visible focus ring using the accent, `aria-label` on icon-only buttons, labelled inputs.

### 6.1 Empty and loading states (the mockup only shows full ones)
Every list view needs: a loading state (skeleton rows, never "Nothing here" while loading), an empty state (mascot + one line +
one action), and a long-content state (long titles truncate on the card face only; the detail view shows everything).
Home with no data: greeting, "Nothing needs you" only after the first load finishes, a "Tell me what you'd like done" prompt.

## 7. Security model
- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a strict CSP meta tag (`default-src 'self'`;
  `img-src 'self' data: https:`; `style-src 'self' 'unsafe-inline'`; `font-src 'self' data: https://fonts.gstatic.com`;
  `connect-src 'self'`; `script-src 'self'`), `webSecurity` on, `setWindowOpenHandler` denies and routes http(s) to the OS browser.
- Navigation: `will-navigate` is blocked for anything but the app itself.
- Secrets: only in `secrets.ts` (safeStorage). If `safeStorage.isEncryptionAvailable()` is false (some Linux), store with file mode 0600
  and set a visible warning in Settings ("Your key is stored without OS encryption on this computer").
- IPC: every handler validates its arguments (type and size); the renderer cannot make the main process read arbitrary paths:
  file tools resolve paths and require them inside a granted folder or an explicit user pick/drop.
- Agent tools that act: always through `ctx.approve` per section 5.3. Shell is never auto-approved.
- The agent's browser (M9) uses its own session partition, separate from the app UI.

## 8. Testing and the gates

`scripts/gate.sh Mx` is the judge. You do not edit it. It runs `npm run typecheck`, `npm run build`, the milestone's vitest
files, and for UI milestones it runs `scripts/shoot.mjs` which opens the renderer (Vite dev server, mock bridge) in headless
Chromium and saves PNGs to `shots/` at 1440x900, 1024x768 and 390x844 in light and dark, and fails on any console error or
horizontal overflow. Claude reads those PNGs at the end, so make them good.

Electron itself cannot be fully exercised here, so main-process logic is written to be testable under plain Node: `db.ts`,
`settings.ts`, `runtime/*` take their dependencies (file paths, `safeStorage`, `Notification`) as parameters and are unit
tested with fakes for the OS bits only. A best-effort Electron boot smoke test (`xvfb-run`) runs in the M3, M6 and M8+ gates;
if the machine lacks the system libraries, the gate prints SKIPPED and continues.

Fakes: `scripts/fake-sync-server.mjs` is a ~100 line Node re-implementation of the four sync endpoints (in memory, same JSON,
same status codes, long-poll `wait`). `packages/core/test/helpers.ts` starts it on port 0. A fake AI server for provider and
agent tests lives in `packages/core/test/fake-ai.ts` (you write it in M1: a local HTTP server that speaks the Anthropic and
OpenAI shapes and returns scripted replies, including tool calls).

## 9. Milestones

Each is a file in `tasks/`. Do them in order, one at a time. A milestone is done when its gate passes and it is committed.

| # | Name | Gives us |
|---|---|---|
| M0 | Scaffold | Monorepo, Electron window that boots, React renderer served in browser with mock bridge, vitest, shoot script working |
| M1 | Core: models, providers, loop | Talk to a model with tools, tested against a local fake AI server |
| M2 | Core: sync | HLC, client, engine, tested against the fake sync server |
| M3 | Main: store, settings, secrets, IPC | Local DB implementing SyncStore, settings, preload `window.agent`, account sign-in and sync wired |
| M4 | Renderer foundation | Tokens, shell, rail, title bar, palette, theme/accents, all views as static screens on the mock bridge |
| M5 | Onboarding live | Sign-in/create account, first sync progress, AI key check, name/colour/mascot, all real |
| M6 | Chat live | Real agent runs: tools v1, question and approval cards, stop, persistence, restart safe |
| M7 | Home, Tasks, Memory, Routines live | Full CRUD on real data, routines scheduler, notifications |
| M8 | Desktop-native | Files, shell, run_code, tray, hotkey Quick Ask, drag-drop, autostart, single instance, window state |
| M9 | Agent browser | Docked live browser panel and `browser_*` tools |
| M10 | Helpers | delegate / steer / push / stop, helper cards, parallel workers |
| M11 | Packaging | electron-builder config for Windows (NSIS + portable), macOS, Linux; icons; CI-ready scripts |

## 10. Definition of done for the whole project
- A person on Windows installs one file, opens it, signs in (or uses the computer only), gives an API key, names their agent,
  and chats; the agent searches and saves memory, manages tasks, runs routines, uses files, shell and the browser with approvals.
- Two desktops with the same account converge (chat, memory, tasks, goals, routines) within seconds.
- Every screen passes the design bar: PNGs at 1440 and 390, light and dark, no overflow, no text under 12px (11px eyebrows
  excepted), contrast >= 4.5:1, no dead buttons.

## 11. What the mockup shows that is not real in v1 (handle exactly like this)
| Mockup element | v1 behaviour |
|---|---|
| "Sign in with your phone" QR | Render the card disabled with a "Coming soon" pill. No fake QR. |
| Subscription rows on the AI step | Rows visible but disabled with "Coming soon". Only "Use an API key" works. |
| "Synced with your phone" title-bar pill | Shows real sync state: "Synced just now", "Syncing", "Offline, will sync later", or "This computer only". |
| Quick Ask global hotkey | Real in M8 (Electron `globalShortcut`). In the browser mock it is Ctrl+Shift+Space inside the page. |
| Agent's browser panel (SkyHop) | Mock bridge shows the demo page. Real in M9. Before M9 the panel shows "The agent's browser opens here when it needs one". |
| Connections: built-in, profiles, machines, accounts | Only "This computer" (folders, shell setting, browser) is real. Profiles, other machines, connected accounts: visible, disabled, "Coming soon". |
| Machines "this computer" | Real: shows the OS, granted folders, shell setting. |
| Helpers | Hidden until M10. |

## 12. Outside this project (do not do, but know)
- **Phone adapter.** The Android app must gain a sync adapter (Room rows <-> `Change`s, integer ids <-> cids, same HLC) before
  "synced with your phone" is true. That is Kotlin work in `~/phone-aos`, done separately. Until then desktop syncs desktop-to-desktop.
- **Tablet layout on the phone app** is bad (a stretched phone layout). Separate fix in `~/phone-aos`.
- **Hosting the sync service** for real users (domain, TLS, backups, rate limits, email verification, password reset). Separate.
- **Code signing** certificates for Windows and macOS. Separate; M11 only prepares the config.

## 13. Finishing pass (Claude, after M11)
Claude will: read every screenshot at 1440 and 390 in both themes against the mockup; click every button at both widths and write down
what it did; run the real sync service (`~/agent-desktop/sync-service`) against two app instances and confirm convergence; drive a
real agent conversation with a real key through every tool group; fix what DeepSeek got wrong; run the Electron smoke test on
the Windows machine (`ssh pc2`) and build the installer there; and write the release notes.
