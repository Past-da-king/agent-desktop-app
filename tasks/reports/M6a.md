# M6a report: chat runtime (main process)

## Built

- `apps/desktop/src/main/runtime/time.ts`: one place for the computer timezone and the
  "Tuesday 20 October 2026, 16:58 (Africa/Johannesburg)" wording, shared by the prompt and `now`.
- `apps/desktop/src/main/runtime/recall.ts`: `terms`, `rank` and `formatMemory`, ported from
  `Recall` in `reference/phone/tools/MemoryTools.kt` (title 3, topics 2, body 1, small bonus for a
  longer substring, pinned and recency, top n). Ties go to the most recently updated page.
- `apps/desktop/src/main/runtime/prompt.ts`: `buildSystemPrompt({settings, now, platform, memories,
  goals, tasks, latestUserText, timeZone?})`. The MAIN prompt from `AgentRuntime.kt`, rewritten for a
  desktop: name lines, date with zone, YOUR JOB, ASSUME YOU ALREADY KNOW, memory-as-wiki with
  `[[Name]]` links, to-do rules, goals and tasks, routines, approvals, reports, STYLE, pinned
  memories, recalled memories (newest 8, never repeating a pinned one), and open goals and tasks.
  It names Windows, macOS or Linux from `platform`, and never mentions a handheld, Android, connected
  apps, cards or voice.
- `apps/desktop/src/main/tools/memory.ts`: `memory_search`, `memory_get`, `memory_save`,
  `memory_update` (plus delete), all as plain text. `memory_save` finds a page by its exact title,
  ignoring case and surrounding spaces, and updates it instead of adding a duplicate. `memory_get`
  takes an id, with an exact-title fallback, and lists the pages that link to it.
- `apps/desktop/src/main/tools/tasks.ts`: `task_add`, `task_list`, `task_update`, `goal_create`.
  Owners are `user` (their to-do list) and `agent` (working steps). `dueAt` accepts ISO datetime or
  date-only (09:00 local). Blocking sets a blocker; leaving `blocked` clears it. A goal becomes
  `achieved` when every task under it is done. `task_list` shows open work by default and filters by
  status when asked.
- `apps/desktop/src/main/tools/core.ts`: `now`, `ask_user`, `request_approval` (returns
  "The user declined." on decline), `notify_user`, `web_fetch`, `report`.
  `web_fetch` is GET only, https except loopback, no cookies, 20 s timeout, manual redirects with
  every hop re-checked, DNS resolution before the request, private/link-local/unspecified addresses
  blocked, HTML stripped to readable text, 12000 characters by default and never more. `allowLoopback`
  is injectable for tests. `report` writes a `report` chat item with title, markdown and word count.
- `apps/desktop/src/main/runtime/data.ts`: the structural `DataStore` slice (`list`, `get`, `upsert`,
  `remove`) the runtime and tools need. `Store` satisfies it; tests use the real store.
- `apps/desktop/src/main/runtime/toolset.ts`: the one registry. `buildToolset(deps)` returns a plain
  array with one line per group, so M7 to M10 append a single line each.
- `apps/desktop/src/main/runtime/runner.ts`: `Runner` with `send`, `stop`, `state`, `answer`,
  `decide`, `restore` and `dispose`.
  - `send` writes the user row, then either runs or queues into the steer inbox. Leftover queued
    messages start a follow-up run instead of being dropped.
  - The transcript is the `turn` rows for thread `main`: repaired (paired tool calls and results) and
    trimmed before the provider sees it. Every appended message is persisted.
  - Every tool call becomes one `activity` row whose meta moves from
    `{tool, status:'running', summary}` to `done` or `error`. Assistant text becomes `agent` rows.
  - `ask_user` writes a `question` row (`{options, answer}`); `request_approval` writes an
    `approval` row (`{summary, details, decision}`). Both suspend the tool, emit `needs_you`, and
    notify when notifications are on and the window is not focused.
  - `stop()` aborts, resolves any suspended card, keeps its unanswered row in `waiting`, and the run
    ends with a `Stopped` notice.
  - `restore()` turns a `running` activity into `{status:'error', summary:'Interrupted'}` and
    re-arms unanswered cards. Answering one later starts a fresh turn with the answer, with the old
    transcript still in front of it.
  - No key, no model, or a custom provider with no address writes a plain notice and never calls a
    provider. Provider failures become a notice plus `run_finished {error}`.
- `apps/desktop/src/main/ipc.ts`: the `chat.*` handlers with argument limits (message 20000,
  answer 4000, 20 attachments of path/name/mime). `IpcDeps` gains `chat: ChatRunner`; routines and
  file picking still answer "not implemented yet".
- `apps/desktop/src/main/index.ts`: builds the real toolset and runner, passes the live provider
  factory, broadcasts `agent:evt:chat.event`, shows Electron notifications, focuses-gates them,
  nudges sync on every local store write, runs `restore()` before the window opens, and stops the
  runner before the store closes.
- Preload and mock bridge needed no changes; the chat methods were already in the contract.

## Tests

73 new tests in `apps/desktop/test/` (163 in the repo, 12 in `runner.test.ts`):

- `recall.test.ts` (8): term filtering, title over body, topics over body, irrelevant pages dropped,
  pinned tie-break, recency ordering for an empty query, limit.
- `prompt.test.ts` (11): names, date and zone, each platform, pinned and recalled memories (no
  duplicates), open goals and tasks only, no handheld or Android wording, no emoji, no em dash,
  recalled list cap.
- `tools-memory.test.ts` (8): save fields, dedupe by title, unknown kind, search, get by id and
  title, backlinks, update and delete, misses.
- `tools-tasks.test.ts` (9): owners, due dates and the date parser, goal listing, status filtering,
  blocker set and clear, goal achieved, misses.
- `web-fetch.test.ts` (14): HTML stripping, plain text, redirects, redirect loop, HTTP errors, the
  character cap, binary files, timeout, private ranges, plain http rules, loopback opt-out, invalid
  addresses, address classification.
- `runner.test.ts` (12): simple reply and turn persistence, a memory_save chain, ask_user suspend and
  continue, declined approval reaches the model, stop mid-run, provider 500, restart repair and
  re-armed card, a second message merged while working, no key means no provider call, attachments,
  needs-you notification, stop with nothing running.
- `ipc-contract.test.ts` updated: chat is real now, so the old "not implemented" assertion covers
  routines and files only, plus a no-key chat round trip and argument rejection.

`bash scripts/gate.sh M6a` prints `GATE M6a PASSED`.

## Deviations and decisions

- `packages/core/src/loop.ts` now checks the abort signal immediately after a provider reply. Without
  it a reply that landed after Stop was still rendered and its tools still ran, because the loop only
  checked at the top of a step. This makes `AbortSignal` mean what PLAN.md 5 says.
- The prompt says routines exist (`routine_create`, `routine_list`) because PLAN.md 5.2 asks for the
  routines rules; the tools arrive in M7. Until then a model that tries them gets the loop's normal
  unknown-tool result.
- `memory_save` treats titles case-insensitively and trims spaces. "Exact title" in the brief, but a
  page called "Lerato" and one called "lerato" are the same page to a person.
- Recall trims dots from the ends of query words ("Durban." matches "durban"). The Kotlin splitter
  leaves the dot on the word and then misses the match.
- `report` has no `summary` parameter (the brief says title and markdown), so its `text` is the title
  and its meta carries `{title, markdown, words}` for the reader.
- `web_fetch` follows redirects manually so each new address goes through the same private-network
  check. DNS is resolved twice (check, then fetch). A hostile DNS server that changes its answer
  between the two could still reach an internal address; closing that needs a pinned address in the
  socket layer, which is out of scope for v1. Plain http is refused for anything but loopback.
- Tools do not call `ctx.activity` for every action: the runner already writes one activity row per
  tool call, and two rows per call would be noise. `ToolContext.activity` / `updateActivity` are
  implemented anyway (numeric handle mapped to the row id) so M8 tools can add detail rows.
- The runner's `state()` is synchronous; Electron's `ipcMain.handle` still resolves it to a promise
  for the renderer, so the `AgentApi` contract is unchanged.
- No new dependencies.

## Notes for M6b (renderer)

- Chat rows: `user`, `agent`, `activity`, `question`, `approval`, `notice`, `report`. Activity meta is
  `{tool, status, summary}` with status `running`, `done` or `error`. Question meta is
  `{options: string[], answer: string}`; approval meta is
  `{summary, details, decision: 'approve' | 'decline' | ''}`.
- `chat.state()` returns `{running, waiting}`. `waiting` includes cards re-armed from a previous
  session, so it is safe to drive the "needs you" strip from it, or from unanswered rows.
- `chat.answer` and `chat.decide` work after a restart: the runner starts a new turn with the answer.
- Stop leaves the unanswered card in `waiting`; its row is still there to answer.
- Report meta carries the full markdown for the reader dialog. User rows carry
  `{attachments: [{path, name, mime}]}`. Image attachments are sent to the model when the file
  still exists.
- A chat event is `run_started`, `thinking`, `chat_changed`, `needs_you` or `run_finished` (with an
  optional plain-words `error`). `data.onChanged('chat_item')` also fires on every row write, so a
  single reload path is enough.
- `chat.send` only resolves when the run it started has finished (or reached a card). Do not await it
  on the UI thread.

## Notes for M7 and later

- Add a tool group by appending one line to `buildToolset`. If a group needs more than the store,
  extend `CoreToolDeps` (or add its own deps type) and thread it through `ToolsetDeps`.
- The runner has no public "run this prompt in the background" method yet. M7's scheduler will want
  one (a routine run should not insert a user bubble). The pieces are `begin(text, images, user)` with
  `user = null`, and `continueAfterCard` is the existing example.
- The IPC chat block is together in `ipc.ts`, and `IpcDeps.chat` is the seam a scheduler or files
  milestone should reuse rather than constructing a second runner.
- Chat turn rows are `thread: 'main'` only in v1. Helpers in M10 should use their own thread value;
  `loadHistory` already ignores anything else.
