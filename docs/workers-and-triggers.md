# Workers and event triggers

Status: slice 1 built and proven, 22 Oct 2026: 0.2.39 (87530e6) workers, inbox, event routines, desks; 0.2.40 (a57b149) desks delegate on a plan; 0.2.41 (d7f14be) polish. Decisions D1 to D6 below were all taken as recommended (D1: Socket Mode wherever the app can be installed, polling where it cannot). An example chat worker is in `docs/examples/workers/`.

Proof on the real Windows build (a separate test copy with its own data folder): a real chat workspace worker caught up 6 real messages after a hard kill of the app and a relaunch, the desk ran on the plan, handed two requests to helpers and reported to the main agent, which followed up; after a second restart the desk said they were the same six as last time (it remembers). Killing the worker brought it back in 1.4 s from its cursor with no duplicates. A broken key went to failing after 5 tries with the real error on the Workers page, a Needs-you card on Home and a notice in the chat.

## 1. The problem

Routines fire on a clock only (`TriggerRow.kind`: at, daily, interval; `runtime/scheduler.ts` ticks every 30 s). Nothing outside the app can wake the agent: a chat message, a mail, a WhatsApp message, a process that finished. Every routine run is also a fresh, stateless background turn (`runner.runRoutine`), so eight events meet eight strangers.

The person wants messages to wake the agent and get routed to work, for any source. Ruled out from the start:

- a per-source feature (no Slack code, Gmail code or WhatsApp code in the app),
- anything shaped to one person's setup,
- anything invisible: every worker, its last run and what it emitted must be on screen and editable,
- silent loss: closing and reopening the app must catch up, never drop. (The previous system lost cron slots at boot with no error shown.)

## 2. The idea: two primitives

There are four ways anything can tell us something:

| Way | Example | Latency | Needs |
|---|---|---|---|
| Poll | ask an API every N minutes | up to N | nothing new |
| Outbound connection | Slack Socket Mode, IMAP IDLE, a WhatsApp bridge | instant | a process that stays alive |
| Public relay | a webhook caught on a server and forwarded | instant | hosting |
| Local process | folder change, a running app, a browser tab | instant | a process that stays alive |

The last three are one thing: a process that stays alive and emits when something happens. Polling is the same process with a sleep in it. So the app needs exactly:

1. **Workers**: start a background process, supervise it, restart it when it dies, bring it back when the app opens, and take events from it in one format. The app knows nothing about any source; the source-specific part is a script the agent writes, i.e. a tool, not a feature.
2. **Triggers on routines**: a routine fires on a clock or on an event. Same routine body, same standing helper, whatever fired it.

"A script trigger" (an agent-written watcher) is not a third mechanism: it is a worker in `every` mode (run, emit, exit, run again in N minutes). Clock, event and script therefore become two trigger kinds over one worker contract.

## 3. Worker contract

A worker is a folder plus a manifest. The agent writes it; the app runs it.

```
<userData>/workers/<id>/
  worker.json      manifest (below)
  main.mjs         entry (or main.py / main.ps1 / any command)
  ...              anything else it needs
  state/           the worker's own scratch space (kept across restarts)
```

`worker.json`:

```json
{
  "id": "w_8f2c",
  "name": "Team chat: DMs and mentions",
  "about": "Holds a Socket Mode connection and emits each DM and mention.",
  "entry": "main.mjs",
  "runtime": "node",
  "mode": "stay",
  "everyMinutes": null,
  "secrets": ["SLACK_APP_TOKEN", "SLACK_USER_TOKEN"],
  "profile": "<profile id or empty>",
  "device": "<device id that runs it>",
  "enabled": true
}
```

- **runtime**: `node` runs through the app's own binary (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), so no installed Node is assumed. `python`, `powershell`, `command` are allowed only when the environment scan found them (`runtime/environment.ts`), spawned through `runtime/spawn.ts`.
- **mode**: `stay` (long-lived, restarted when it exits) or `every` (run, emit, exit; started again after `everyMinutes`, at least 1).
- **secrets**: names only. Values live in safeStorage (`secrets.ts`) as `worker:<id>:<NAME>` and are passed as environment variables. A secret value is never in the folder, the manifest, a log or an event.
- **device**: workers are per computer. A synced worker row on another device shows as "runs on <device>" and is not started there.

### Environment the app gives it

| Variable | Meaning |
|---|---|
| `AGENT_WORKER_ID` | its id |
| `AGENT_WORKER_DIR` | its folder |
| `AGENT_WORKER_CURSOR` | the last cursor it reported (empty on first run) |
| `AGENT_WORKER_DOWN_SINCE` | ms epoch when it last stopped (empty on first run): how far back to catch up |
| one variable per declared secret | the value |

### What it writes (stdout, one JSON object per line)

```json
{"type":"ready"}
{"type":"event","source":"slack","event":"message.dm","payload":{...},"dedupeKey":"T01/D02/1729580000.1234","seenAt":1729580000123}
{"type":"cursor","value":"1729580000.1234"}
{"type":"alive"}
{"type":"log","level":"info","text":"connected"}
```

- `event`: the one event format, `{source, event, payload, seenAt, dedupeKey}`. `payload` is JSON, capped at 32 KB (larger is cut and flagged). `dedupeKey` is required: the same key from the same worker is stored once, so a worker may re-send freely after a restart.
- `cursor`: a checkpoint. The app stores it and hands it back as `AGENT_WORKER_CURSOR` on the next start. This is how missed messages are caught up: on start, the worker fetches everything after its cursor, then goes live.
- `alive`: heartbeat. A `stay` worker that writes nothing (alive, event, log) for 90 s is treated as hung and restarted.
- stderr and any non-JSON line become log lines. Nothing is lost silently.
- stdin: the app writes `{"type":"stop"}` before stopping it; the worker has 5 s to save state and exit, then the process tree is killed (`killProcessTree`).

Any language that can print a line can be a worker. A drop folder, a local HTTP listener, a background app (a home-made app emitting when a job finishes) or a relay client are all just workers; none needs app code.

### Page workers (later slice)

Some sources only exist as a signed-in web page (WhatsApp Web). A page worker uses the same contract with a different host: its body runs in a background tab of its profile's browser partition (the same way learned-app tools run, `apps/page-js.ts`), and calls `emit({...})` / `cursor(...)` / `alive()` instead of printing. The person scans the QR once in that tab; from then on the worker observes the page and the learned-app tools behind it read and send.

## 4. Supervision and startup

A `Supervisor` in main (`runtime/workers.ts`), started next to the `Scheduler` in `index.ts`.

- **On app start**: start every enabled worker whose `device` is this one. Each start records `startedAt` and passes `AGENT_WORKER_DOWN_SINCE`, so the gap is visible and the worker catches up.
- **On exit or hang**: restart with backoff 1 s, 2 s, 4 s ... up to 5 min. Five failures in 10 minutes = state `failing`: stop retrying, post one Needs-you card ("Team chat worker keeps failing: <last error>", Restart / Open logs), never a silent stop.
- **On sleep/resume** (`powerMonitor` resume, already wired for the scheduler): restart any `stay` worker whose last line is older than the heartbeat window.
- **On quit**: stop message, 5 s grace, kill tree. Last cursor and `stoppedAt` saved.
- **Closed app**: workers are children of the app, so they stop when it fully quits. The app already lives in the tray and has `launchAtLogin`. What was missed while closed is caught up on the next start through the cursor, and the Workers page says "down 22:10 to 07:42, caught up 14 events".

Visible state per worker: running / starting / stopped / failing, pid, up since, last event at, events today, restarts today, last error, the last 500 log lines (ring buffer on disk), and its events.

## 5. Events: the inbox

Each event becomes a local `event` record before anything else happens:

`{id, worker, source, event, payload, dedupeKey, seenAt, receivedAt, status: new | routed | ignored | failed, routine, run}`

- Unique on `(worker, dedupeKey)`: a duplicate is dropped and counted.
- Stored first, routed second. If the app closes before a run finishes, `new` events are routed on the next start. That is the catch-up guarantee on the routine side.
- Kept 14 days or 10,000 rows, oldest out first.
- Not synced by default (private message content stays on this computer; see decision D3).
- An event that matches no routine is kept as `ignored`, visible, so "why did nothing happen" always has an answer.

## 6. Triggers on routines

`TriggerRow` gains one kind and two fields:

```ts
kind: 'at' | 'daily' | 'interval' | 'event'
spec: string          // for event: JSON filter, e.g. {"worker":"w_8f2c","event":"message.*"}
gatherSeconds?: number // event only: collect matching events for N s into ONE run (default 20)
desk?: boolean         // run in this routine's standing helper (section 7), default true for event routines
```

- Filter: `worker` and/or `source`, `event` with `*` wildcards, and optional `match` (payload field equals / contains). Kept deliberately small; anything smarter is the routine prompt's job.
- A run gets the routine prompt plus the batch of events as data (clipped), marked untrusted (they are other people's words).
- Clock routines keep today's rules (one catch-up per missed slot, not once per slot). New: a missed or failed run writes a visible line on the routine, never nothing.
- Concurrency: today one routine at a time. Event routines get one queue each (events for a routine never overlap, so its desk sees them in order) and up to 2 routine runs at once overall (D6).
- Older builds that sync an `event` row: `isDue` has no case for it and returns falsy, so they ignore it; the Routines page shows "needs a newer version".

## 7. The desk: one standing helper per event routine

So each source has one colleague who remembers, not a new agent per event.

- A desk is a helper thread with a fixed id `helper:desk-<routineId>`. Its transcript persists in `turn` rows like any helper's, and every run of that routine appends to it.
- It runs with the routine's prompt as its standing brief, the routine's profile, and the helper toolset plus: `delegate` (start a helper in any profile), `project_chat_start`, and `tell_main`.
- It does not do long work itself. It reads the event, checks memory, decides who owns it, hands it out, and calls `tell_main`: "Gave the invoice question from the payroll contact to a helper in the work profile (#h12)". That lands in the main chat as a helper line, so the main agent can follow up and the person only ever talks to the main agent.
- Anything that goes out in the person's name (a reply, a send) stays an approval card in the main chat, as today.
- Steering: the main agent can `helper_steer` the desk like any helper.
- Compression: the End of day pass (`memory/routine.ts`) gets one more step: each desk transcript is summarised into a memory page "Desk: <routine name>" (who is who, open threads, what was handed to whom) and the transcript is reset to that summary. Within a day, the existing trim keeps it inside the model's window.

## 8. How an agent authors a worker

New tools in `tools/workers.ts`:

| Tool | Does | Asks first |
|---|---|---|
| `worker_guide` | the contract above, with a Node template | no |
| `worker_create` | name, about, runtime, mode, files, secret names, profile | yes: shows the code and which secrets it reads |
| `worker_test` | runs it once in dry mode for up to 60 s, returns emitted events and logs, routes nothing | no |
| `worker_update` | new code or manifest | yes, shows the diff |
| `worker_list`, `worker_logs`, `worker_events` | read state | no |
| `worker_start`, `worker_stop`, `worker_restart` | control | no |
| `worker_delete` | removes it and its secrets | no (undo for 10 s in the UI) |
| `secret_request` | asks the person for a key through a secure field card, never through chat | the card is the ask |

Flow: the agent reads the guide, writes the script, `worker_test`s it until events look right, `worker_create`s it (one approval), then `routine_create` with `kind: event`. The next source is the same five steps and no app release.

## 9. In the app

Routines page gets a Workers section (or tab): one row per worker with a state dot, up since, last event, events today, restarts; open it for Logs, Events (each with the routine and run it went to), Start/Stop/Restart, Edit (opens the folder), Delete. Routines show their trigger in plain words ("When Team chat sends a DM or mention, after 20 s") and link to their desk's transcript. Home "Needs you" shows failing workers.

## 10. Smallest first slice: Slack DMs and mentions, end to end

Build:
1. `Supervisor` (stay mode only), the stdout contract, cursor and down-since, backoff and failing state.
2. Event inbox with dedupe, route-on-start for `new` events.
3. `kind: 'event'` on routines with the small filter and `gatherSeconds`.
4. The desk: persistent helper thread, `tell_main`. (Compression comes in slice 2; the existing trim covers a day.)
5. Tools: `worker_guide`, `worker_create`, `worker_test`, `worker_list`, `worker_logs`, `worker_events`, `worker_restart`, `secret_request`.
6. Workers section on the Routines page: state, logs, events.
7. Then, with no app code: the agent writes the Slack worker as a tool (Socket Mode or polling, D1), it catches up from its cursor on start with `conversations.history` / `search.messages`, and one routine "Team chat desk" is created on it.

Proof, done the way the person will use it:
- Send a DM from the phone: an event shows on the Workers page within 10 s, the desk runs, the main chat gets a line naming who got the job.
- Quit the app fully, send two DMs, reopen: both arrive once each, the page shows the downtime and "caught up 2".
- Kill the worker process in Task Manager: it is back within seconds, restarts counted.
- Break the token: the worker goes `failing` and a Needs-you card appears, not silence.
- Tests: supervisor with a fake process (restart, backoff, failing, heartbeat, stop grace), inbox dedupe, route-on-start, `isDue` ignoring `event`, desk transcript continuity.

Slice 2: `every` mode (script triggers), desk compression in End of day, mail (Graph or IMAP worker) and Teams.
Slice 3: page workers and WhatsApp Web, drop-folder and local-listener templates.

## 11. Decisions that need the person

- **D1 Slack route.** (a) Socket Mode: instant, needs a Slack app with an app-level token installed in each workspace, which may need that workspace's admin. (b) Polling with a user token every 1 to 2 minutes: no admin, slower. (c) Socket Mode in the workspace he owns, polling in the one he does not. Recommended: (c).
- **D2 Worker approvals.** A new worker and any code change ask once (it is code running all day with keys); after that it runs without asking. Recommended.
- **D3 Events stay on this computer**, not synced. Recommended.
- **D4 Where workers live.** Inside the app (stop when it fully quits, caught up on open; tray plus launch at login keep it up) rather than a separate Windows service. Recommended: inside the app now; a service only if gaps hurt.
- **D5 Desk powers.** The desk may start helpers and project chats on its own and must tell the main agent each time; replies and sends always come as approval cards. Recommended.
- **D6 Concurrency.** Event routines run alongside clock routines, at most 2 runs at once. Recommended.

Nothing is installed or restarted by this plan. Shipping slice 1 follows the normal release path; installing it restarts the app and needs a yes.
