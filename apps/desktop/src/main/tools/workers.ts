/**
 * Worker tools (docs/workers-and-triggers.md, section 8): an agent writes a background worker as a small script,
 * tests it, saves it once with the person's approval, and from then on the app keeps it running. Everything about a
 * source (a chat app, a mailbox, a folder, a page) lives in the script, never in the app.
 */
import { enumOf, int, normaliseManifest, schema, str, strList, type JsonObject, type Tool, type ToolContext, type WorkerInfo, type WorkerManifest } from '@agent/core'

import type { WorkerStore } from '../workers/store'
import type { Supervisor } from '../workers/supervisor'

export interface WorkerToolDeps {
  store: WorkerStore
  supervisor: Supervisor
  /**
   * This computer's "Run without asking" choice for commands (Settings). A worker is code that runs on this
   * computer, so with 'always' adding or changing one needs no card, like a command (main/ask-rule.ts).
   */
  commands?: () => 'always' | 'ask' | 'never'
}

/** Adding or changing a worker asks only when commands on this computer ask too. */
function workerAsks(deps: WorkerToolDeps, ctx: ToolContext): boolean {
  return (ctx.shell ?? deps.commands?.() ?? 'ask') !== 'always'
}

export const WORKER_GUIDE = `WRITING A WORKER (a background process that tells you when something happens)

A worker is a small program in its own folder. The app starts it when the app opens, keeps it running, restarts it if it dies, and turns each line it prints into an event that an event routine (routine_create kind "event") picks up. Nothing about the source is built into the app: the socket, the polling or the folder watching is your script.

THE CONTRACT. Print one JSON object per line on stdout:
  {"type":"ready"}                                   once connected
  {"type":"event","source":"chat","event":"message.dm","payload":{...},"dedupeKey":"<unique id>","seenAt":1729580000123}
  {"type":"cursor","value":"<checkpoint>"}           after you have emitted everything up to a point
  {"type":"alive"}                                   at least every 60 s when nothing else happens
  {"type":"log","level":"info","text":"..."}         anything worth seeing on the Workers page
- dedupeKey is required and must be stable for the same thing (a message id), so re-sending after a restart is harmless.
- payload: only what the desk needs (who, where, text, a link), at most 32 KB.
- stderr and any other output become log lines. Never print a token or key.
- When stdin says {"type":"stop"}, save and exit within 5 s.

CATCHING UP. On start you get AGENT_WORKER_CURSOR (your last cursor, empty the first time) and AGENT_WORKER_DOWN_SINCE (ms epoch when it last stopped, empty the first time). First fetch everything after the cursor (or since DOWN_SINCE), emit it, then go live. This is how nothing is lost while the app was closed. AGENT_WORKER_TEST=1 means a test run: emit as usual, exit when done.

KEYS. Declare secret NAMES in the manifest ("secrets": ["CHAT_TOKEN"]). Each arrives as an environment variable. The person types the value on the Workers page, or you set it with worker_secret_set (they approve), or a script writes secrets.drop.json ({"CHAT_TOKEN":"..."}) into the folder and the app moves it to its encrypted store on the next start. Never put a key in a file you write or in your reply.

RUNTIME. "node" runs on the app's own engine (no install needed): Node 22+, global fetch and WebSocket, no npm packages, so use built-ins only. "python", "powershell" or "command" only when that program is on this computer. mode "stay" stays alive (a socket, a watcher); mode "every" runs, emits, exits, and runs again every everyMinutes (polling).

STEPS. 1) Write it. 2) worker_create (the person approves the code once, unless commands run without asking). 3) Set its keys. 4) worker_test until the events look right. 5) routine_create kind "event" with spec {"worker":"<id>"} and a standing brief. 6) worker_list / worker_logs / worker_events to watch it.

NODE TEMPLATE (mode stay):
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let cursor = process.env.AGENT_WORKER_CURSOR || ''
process.stdin.on('data', (d) => { if (String(d).includes('"stop"')) process.exit(0) })
setInterval(() => out({ type: 'alive' }), 30000)
async function catchUp() { /* fetch everything after cursor, out({type:'event',...}) each, then out({type:'cursor',value:newest}) */ }
async function live() { /* open the socket or watch; on each item: out({type:'event',...}); out({type:'cursor',value:id}) */ }
catchUp().then(() => { out({ type: 'ready' }); return live() }).catch((e) => { console.error(e.message); process.exit(1) })`

export function workerTools(deps: WorkerToolDeps | undefined): Tool[] {
  if (deps === undefined) return []
  return [guide(), create(deps), update(deps), test(deps), list(deps), logs(deps), events(deps), control(deps), remove(deps), secretSet(deps)]
}

function guide(): Tool {
  return {
    spec: {
      name: 'worker_guide',
      description: 'How to write a background worker (a process that tells you when something happens: a chat message, a mail, a file, a page change). Read it before worker_create.',
      schema: schema([], {}),
    },
    run: async () => WORKER_GUIDE,
  }
}

const MANIFEST_PROPS: Record<string, JsonObject> = {
  name: str('Short name the person sees, e.g. Team chat: DMs and mentions'),
  about: str('One line: what it watches and what it emits'),
  runtime: enumOf('What runs it. node needs nothing installed', 'node', 'python', 'powershell', 'command'),
  entry: str('The file to run, inside its folder, e.g. main.mjs'),
  mode: enumOf('stay = keeps running (socket, watcher); every = runs, emits, exits, runs again', 'stay', 'every'),
  every_minutes: int('mode every only: minutes between runs, at least 1'),
  secrets: strList('Names of the keys it reads as environment variables, CAPITALS_AND_UNDERSCORES. Values are set separately'),
  args: strList('Extra arguments after the entry (optional)'),
  files: { type: 'object', description: 'The files to write into its folder: {"main.mjs": "<code>"}. Text only.', additionalProperties: { type: 'string' } },
}

function create(deps: WorkerToolDeps): Tool {
  return {
    spec: {
      name: 'worker_create',
      description: 'Save a new background worker and start it. The person approves the code once, unless commands on this computer run without asking. Read worker_guide first.',
      schema: schema(['name', 'entry', 'files'], MANIFEST_PROPS),
    },
    run: async (input, ctx) => {
      const id = deps.store.newId()
      const now = Date.now()
      const manifest = normaliseManifest(manifestInput(input, { createdAt: now, updatedAt: now }), id)
      if (typeof manifest === 'string') return `Not created: ${manifest}.`
      const files = filesOf(input['files'])
      if (typeof files === 'string') return `Not created: ${files}`
      if (manifest.runtime !== 'command' && files[manifest.entry] === undefined) return `Not created: files must include the entry, ${manifest.entry}.`
      const approved = !workerAsks(deps, ctx) || (await ctx.approve(`Add a background worker: ${manifest.name}`, approvalText(manifest, files, null), 'computer'))
      if (!approved) return 'The user declined.'
      try {
        deps.store.write(manifest, files)
      } catch (error) {
        return `Not created: ${message(error)}`
      }
      const missing = manifest.secrets
      if (missing.length === 0) deps.supervisor.startWorker(id)
      await ctx.activity(`New worker: ${manifest.name}`, { tool: 'worker_create' })
      return missing.length === 0
        ? `Worker ${id} saved and started. Check it with worker_test or worker_logs, then make an event routine for it (routine_create kind event, spec {"worker":"${id}"}).`
        : `Worker ${id} saved, not started yet: it needs its keys (${missing.join(', ')}). Set them with worker_secret_set or ask the person to type them on the Workers page, then worker_control start.`
    },
  }
}

function update(deps: WorkerToolDeps): Tool {
  return {
    spec: {
      name: 'worker_update',
      description: 'Change a worker: new or changed files and any manifest field. The person approves the change once; the worker restarts with it.',
      schema: schema(['id'], { id: str('Worker id, w_...'), ...MANIFEST_PROPS }),
    },
    run: async (input, ctx) => {
      const id = text(input['id']).trim()
      const current = safeManifest(deps, id)
      if (current === null) return `No worker ${id}.`
      const merged = normaliseManifest(manifestInput(input, current), id)
      if (typeof merged === 'string') return `Not changed: ${merged}.`
      const files = input['files'] === undefined ? {} : filesOf(input['files'])
      if (typeof files === 'string') return `Not changed: ${files}`
      const before: Record<string, string | null> = {}
      for (const name of Object.keys(files)) before[name] = safeRead(deps, id, name)
      const approved = !workerAsks(deps, ctx) || (await ctx.approve(`Change the worker: ${merged.name}`, approvalText(merged, files, before), 'computer'))
      if (!approved) return 'The user declined.'
      try {
        deps.store.write({ ...merged, updatedAt: Date.now() }, files)
      } catch (error) {
        return `Not changed: ${message(error)}`
      }
      if (merged.enabled) await deps.supervisor.restart(id)
      await ctx.activity(`Changed worker: ${merged.name}`, { tool: 'worker_update' })
      return `Worker ${id} changed${merged.enabled ? ' and restarted' : ''}.`
    },
  }
}

function test(deps: WorkerToolDeps): Tool {
  return {
    spec: {
      name: 'worker_test',
      description: 'Run a saved worker once, for up to `seconds` (default 30, at most 120), and see what it emits and logs. Nothing is stored or routed. Its keys are passed as usual.',
      schema: schema(['id'], { id: str('Worker id'), seconds: int('How long to let it run, default 30') }),
    },
    run: async (input) => {
      const id = text(input['id']).trim()
      const manifest = safeManifest(deps, id)
      if (manifest === null) return `No worker ${id}.`
      const seconds = typeof input['seconds'] === 'number' ? input['seconds'] : 30
      const run = await deps.supervisor.test(manifest, deps.store.dirOf(id), seconds)
      const eventLines = run.events.slice(0, 15).map((e, i) => `${i + 1}. ${e.source}/${e.event} key=${e.dedupeKey} ${clip(JSON.stringify(e.payload), 400)}`)
      const logLines = run.logs.slice(-25).map((l) => `[${l.level}] ${clip(l.text, 300)}`)
      return [
        `Ran ${Math.round(run.ranMs / 1000)} s, exit ${run.exitCode === null ? 'none (stopped by the test)' : run.exitCode}.`,
        `Events: ${run.events.length}${run.events.length > 15 ? ' (first 15)' : ''}`,
        ...eventLines,
        `Cursor: ${run.cursor ?? 'none'}`,
        'Log:',
        ...(logLines.length === 0 ? ['(nothing)'] : logLines),
      ].join('\n')
    },
  }
}

function list(deps: WorkerToolDeps): Tool {
  return {
    spec: {
      name: 'worker_list',
      description: 'The background workers: state, when each last emitted, events and restarts today, the last error, and missing keys.',
      schema: schema([], {}),
    },
    run: async () => {
      const all = deps.supervisor.info()
      if (all.length === 0) return 'No workers yet. worker_guide explains how to write one.'
      return all.map(describe).join('\n')
    },
  }
}

function logs(deps: WorkerToolDeps): Tool {
  return {
    spec: {
      name: 'worker_logs',
      description: "The last lines of a worker's log, oldest first.",
      schema: schema(['id'], { id: str('Worker id'), limit: int('How many lines, default 60') }),
    },
    run: async (input) => {
      const id = text(input['id']).trim()
      if (safeManifest(deps, id) === null) return `No worker ${id}.`
      const lines = deps.store.logs(id, typeof input['limit'] === 'number' ? input['limit'] : 60)
      if (lines.length === 0) return 'No log lines yet.'
      return lines.map((l) => `${new Date(l.at).toISOString().slice(0, 19).replace('T', ' ')} [${l.level}] ${clip(l.text, 400)}`).join('\n')
    },
  }
}

function events(deps: WorkerToolDeps): Tool {
  return {
    spec: {
      name: 'worker_events',
      description: 'Events workers emitted, newest first: where each went (routed, ignored, failed, new) and why.',
      schema: schema([], {
        id: str('Only this worker (optional)'),
        status: enumOf('Only this status (optional)', 'new', 'routed', 'ignored', 'failed'),
        limit: int('How many, default 20'),
      }),
    },
    run: async (input) => {
      const id = text(input['id']).trim()
      const status = text(input['status']).trim()
      const rows = deps.store.events({
        ...(id === '' ? {} : { worker: id }),
        ...(status === 'new' || status === 'routed' || status === 'ignored' || status === 'failed' ? { status } : {}),
        limit: typeof input['limit'] === 'number' ? input['limit'] : 20,
      })
      if (rows.length === 0) return 'No events.'
      return rows
        .map((e) => `${new Date(e.receivedAt).toISOString().slice(0, 19).replace('T', ' ')} ${e.worker} ${e.source}/${e.event} [${e.status}${e.routine === '' ? '' : ` -> routine #${e.routine}`}] ${e.note} | ${clip(e.payload, 200)}`)
        .join('\n')
    },
  }
}

function control(deps: WorkerToolDeps): Tool {
  return {
    spec: {
      name: 'worker_control',
      description: 'Start, stop or restart a worker. Stop switches it off until started again (it stays off after the app restarts). Start also clears a failing state.',
      schema: schema(['id', 'action'], { id: str('Worker id'), action: enumOf('What to do', 'start', 'stop', 'restart') }),
    },
    run: async (input, ctx) => {
      const id = text(input['id']).trim()
      const manifest = safeManifest(deps, id)
      if (manifest === null) return `No worker ${id}.`
      const action = text(input['action'])
      try {
        if (action === 'start') deps.supervisor.startWorker(id)
        else if (action === 'stop') await deps.supervisor.stopWorker(id)
        else if (action === 'restart') await deps.supervisor.restart(id)
        else return 'action must be start, stop or restart.'
      } catch (error) {
        return message(error)
      }
      await ctx.activity(`Worker ${manifest.name}: ${action}`, { tool: 'worker_control' })
      return `${manifest.name}: ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}.`
    },
  }
}

function remove(deps: WorkerToolDeps): Tool {
  return {
    spec: {
      name: 'worker_delete',
      description: 'Delete a worker: stops it, removes its folder, its keys and its events.',
      schema: schema(['id'], { id: str('Worker id') }),
    },
    run: async (input, ctx) => {
      const id = text(input['id']).trim()
      const manifest = safeManifest(deps, id)
      if (manifest === null) return `No worker ${id}.`
      await deps.supervisor.remove(id)
      await ctx.activity(`Deleted worker: ${manifest.name}`, { tool: 'worker_delete' })
      return 'Deleted.'
    },
  }
}

function secretSet(deps: WorkerToolDeps): Tool {
  return {
    spec: {
      name: 'worker_secret_set',
      description:
        "Store one of a worker's keys in the app's encrypted store (the person approves; the value is never shown back). Prefer letting the person type it on the Workers page when they are there.",
      schema: schema(['id', 'name', 'value'], { id: str('Worker id'), name: str('The secret name the worker declared'), value: str('The value') }),
    },
    run: async (input, ctx) => {
      const id = text(input['id']).trim()
      const manifest = safeManifest(deps, id)
      if (manifest === null) return `No worker ${id}.`
      const name = text(input['name']).trim()
      const value = text(input['value'])
      if (!manifest.secrets.includes(name)) return `${manifest.name} does not declare ${name}. Its keys: ${manifest.secrets.join(', ') || 'none'}.`
      if (value.trim() === '') return 'The value is empty.'
      const approved = await ctx.approve(`Store a key for ${manifest.name}`, `${name} (${value.length} characters) goes into the app's encrypted store and is given only to this worker.`)
      if (!approved) return 'The user declined.'
      deps.supervisor.setSecret(id, name, value.trim())
      return `${name} stored. ${manifest.enabled ? 'Restart the worker (worker_control restart) to use it.' : ''}`.trim()
    },
  }
}

// ---- helpers ----

function manifestInput(input: Record<string, unknown>, base: Partial<WorkerManifest>): Record<string, unknown> {
  const pick = (key: string, field: keyof WorkerManifest): unknown => (input[key] === undefined ? base[field] : input[key])
  return {
    name: pick('name', 'name'),
    about: pick('about', 'about'),
    runtime: pick('runtime', 'runtime') ?? 'node',
    entry: pick('entry', 'entry'),
    mode: pick('mode', 'mode') ?? 'stay',
    everyMinutes: input['every_minutes'] === undefined ? base.everyMinutes : input['every_minutes'],
    secrets: pick('secrets', 'secrets') ?? [],
    args: pick('args', 'args') ?? [],
    enabled: base.enabled ?? true,
    createdAt: base.createdAt,
    updatedAt: Date.now(),
  }
}

function filesOf(value: unknown): Record<string, string> | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'files must be an object of file name: text.'
  const out: Record<string, string> = {}
  for (const [name, content] of Object.entries(value as Record<string, unknown>)) {
    if (typeof content !== 'string') return `${name} must be text.`
    out[name] = content
  }
  return out
}

function approvalText(manifest: WorkerManifest, files: Record<string, string>, before: Record<string, string | null> | null): string {
  const head = [
    `${manifest.about === '' ? manifest.name : manifest.about}`,
    `Runs: ${manifest.runtime} ${manifest.entry}${manifest.args.length > 0 ? ` ${manifest.args.join(' ')}` : ''}, ${manifest.mode === 'stay' ? 'always on, restarted if it stops' : `every ${manifest.everyMinutes} minutes`}.`,
    `Keys it reads: ${manifest.secrets.length === 0 ? 'none' : manifest.secrets.join(', ')}.`,
    'It runs on this computer while the app is open, and starts again each time the app opens.',
  ]
  const bodies = Object.entries(files).map(([name, content]) => {
    const was = before?.[name]
    const label = before === null ? name : was === null || was === undefined ? `${name} (new)` : was === content ? `${name} (unchanged)` : `${name} (changed)`
    return `--- ${label} ---\n${clip(content, 6000)}`
  })
  return [...head, '', ...bodies].join('\n')
}

function describe(w: WorkerInfo): string {
  const at = (t: number | null): string => (t === null ? 'never' : new Date(t).toISOString().slice(0, 16).replace('T', ' '))
  const missing = w.secrets.filter((s) => !w.secretsSet.includes(s))
  return [
    `${w.id} ${w.name} [${w.state}${w.enabled ? '' : ', off'}] ${w.runtime} ${w.mode}${w.mode === 'every' ? ` every ${w.everyMinutes} min` : ''}`,
    `last event ${at(w.lastEventAt)}, ${w.eventsToday} events and ${w.restartsToday} restarts today`,
    w.lastError === '' ? '' : `last error: ${clip(w.lastError, 200)}`,
    missing.length === 0 ? '' : `missing keys: ${missing.join(', ')}`,
    w.lastGap === null ? '' : `last gap ${at(w.lastGap.from)} to ${at(w.lastGap.to)}, caught up ${w.lastGap.caughtUp}`,
  ]
    .filter((part) => part !== '')
    .join(' | ')
}

function safeManifest(deps: WorkerToolDeps, id: string): WorkerManifest | null {
  try {
    return deps.store.manifest(id)
  } catch {
    return null
  }
}

function safeRead(deps: WorkerToolDeps, id: string, name: string): string | null {
  try {
    return deps.store.readFile(id, name)
  } catch {
    return null
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
