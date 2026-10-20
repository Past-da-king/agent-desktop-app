# M6b report: chat UI on the real bridge

## What was built

- `bridge/index.ts` now exports `chat = agent.chat` for both Electron and the browser preview. The old
  `bridge/local-chat.ts` echo adapter (an M4 placeholder) is deleted, so every chat surface in Electron talks
  to the real M6a runner through `window.agent.chat`.
- `state/useWaiting.ts`: one hook that reads `chat.state().waiting`, re-reads it on `needs_you`,
  `chat_changed`, `run_started` and `run_finished`, and falls back to the open rows if the main process cannot
  answer. `lib/cards.ts` gained `cardsForIds`, which keeps only ids that are still unanswered.
- `views/Chat.tsx`, rebuilt around the real thread:
  - the thread is `data.list('chat_item')` through `useEntity`, so it reloads on every `data.onChanged` event;
  - a live thinking row with the mascot morphing, three dots and "Nova is thinking", shown only while the run
    is working and not suspended on a card;
  - tool chips from activity rows: icon, a small tool label (`Memory search`, `Web`, `To-do added`, ...) and
    the summary, with a spinner while running and an error state;
  - question cards with option chips and a free-text answer box, both answer through `chat.answer`;
  - approval cards with Approve/Decline through `chat.decide`, at least 44px tall and full-width on the phone;
  - report cards with a title, word count and preview; "Read the report" opens a real `Dialog` with the full
    markdown (headings, numbered and bulleted lists);
  - user rows show attachment chips from the `attachments` meta the runner writes, and the composer keeps its
    pending attachment chips;
  - a working Stop button while a run is active;
  - autoscroll only when the reader is already at the bottom, and the composer send always jumps to the latest;
  - "New chat" (Rail, Home, palette, Ctrl/Cmd+N) writes a `notice` divider row, keeps all history and scrolls
    the thread to it. A second click while the newest row is already a divider only scrolls.
- `views/Home.tsx`: the "Needs you" strip is driven by `useWaiting()`, so it shows every real waiting question
  and approval and the "Waiting for you on N things" line matches what is on screen. Question cards link to
  the chat for a free-text answer; approvals can be approved from Home.
- `lib/thread.ts` holds the pure thread logic (ordering, branch filtering, divider recognition, title,
  attachments); `ui/Markdown.tsx` gained headings and bullet lists, which the report reader needs.
- The mock bridge still demonstrates every card kind with `?demo=1`: a report card and a second, interactive
  question were added, and the seeded flight request carries an attachment chip.

## Checks

- `npm run typecheck`: clean.
- `npx vitest run`: 180 tests passed, including 12 new renderer tests for thread order, dividers, titles,
  attachments, waiting ids and the demo card kinds.
- `bash scripts/gate.sh M6b`: `GATE M6b PASSED` (build, repo rules, deliverables, 180 tests, 52 screen
  screenshots, 6 chat screenshots).
- Extra local Playwright checks beyond the gate: New chat writes and shows the divider, the free-text answer
  turns a question into the answered card and drops it from the rail badge, the report reader opens and
  closes with Escape, and send shows the thinking row then the reply, with no page or console errors.

## Deviations and decisions

- Home used to show only the first question and called the number of open cards "things", which could say
  "3 things" while drawing 2. It now draws every waiting card so the count is honest.
- The thinking row is hidden while a card waits, even though the runner is technically still inside the
  suspended tool call. Showing "thinking" while the agent is visibly waiting for a person reads wrong.
- "New chat" is a synced `notice` row rather than renderer-only state, so the divider survives a restart and
  syncs to another desktop. It never deletes or archives turns.
- The report reader strips a leading `#` heading that merely repeats the report title, so the dialog does not
  print the title twice.
- The attach button stays "Coming soon" in Electron until the M8 file picker. Drag-and-drop files and files
  picked by the agent still render as chips because the runner's meta shape is supported.

## For the next milestone

- `lib/chat-actions.ts` is the one place New chat is started; keep using it from new entry points.
- `useWaiting()` is safe to reuse for any badge or notification surface that must match the runner's own
  waiting set.
- The report reader and Markdown are shared; M7's report surfaces can reuse `reportText`/`Markdown` rather
  than growing a second renderer.
- The mock bridge resets its in-memory rows on reload, so the New chat divider is only persistent in
  Electron; that is expected and is not a real-store defect.
