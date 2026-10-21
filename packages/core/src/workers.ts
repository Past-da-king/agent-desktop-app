/**
 * Workers: background processes an agent writes and the app supervises (docs/workers-and-triggers.md).
 *
 * The app knows nothing about any source. A worker prints one JSON object per line on stdout; this file is the
 * contract both sides share: the manifest, the line format, the event format, and the small filter an event
 * routine uses to pick its events. Pure TypeScript, safe for the renderer.
 */

export type WorkerMode = 'stay' | 'every'
export type WorkerRuntime = 'node' | 'python' | 'powershell' | 'command'
/**
 * stopped: off, or not started yet. starting: spawned, no line yet. running: alive. waiting: an `every` worker
 * between runs. backoff: died, a restart is scheduled. failing: died too often, the app stopped retrying and the
 * person has a Needs-you card.
 */
export type WorkerState = 'stopped' | 'starting' | 'running' | 'waiting' | 'backoff' | 'failing'

/** worker.json in the worker's own folder. The folder is the source of truth; the person can edit it. */
export interface WorkerManifest {
  id: string
  name: string
  about: string
  /** The file to run, relative to the worker's folder (for runtime `command`: the program, found on PATH or absolute). */
  entry: string
  runtime: WorkerRuntime
  /** Extra arguments after the entry. */
  args: string[]
  mode: WorkerMode
  /** `every` only: minutes between runs, at least 1. */
  everyMinutes: number | null
  /** Names of the secrets it reads. The values live in the app's encrypted store, never in the folder. */
  secrets: string[]
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** One event, the single format every worker emits. */
export interface WorkerEventInput {
  source: string
  event: string
  payload: unknown
  /** Required: the same key from the same worker is stored once, so a worker may re-send freely after a restart. */
  dedupeKey: string
  /** When the source saw it (ms epoch). Defaults to when the app received it. */
  seenAt?: number
}

export type WorkerEventStatus = 'new' | 'routed' | 'ignored' | 'failed'

/** An event as the app keeps it (on this computer only). */
export interface WorkerEvent {
  id: string
  worker: string
  source: string
  event: string
  /** JSON text, at most WORKER_PAYLOAD_MAX characters (cut ones carry `"_cut": true`). */
  payload: string
  dedupeKey: string
  seenAt: number
  receivedAt: number
  status: WorkerEventStatus
  /** The routine it went to, '' when none. */
  routine: string
  /** Why it is ignored or failed, or the desk run it went to. */
  note: string
}

export interface WorkerLogLine {
  at: number
  level: 'info' | 'warn' | 'error'
  text: string
}

/** A worker as the window and the agent see it: its manifest plus what the supervisor knows. */
export interface WorkerInfo extends WorkerManifest {
  dir: string
  state: WorkerState
  pid: number | null
  /** When the current process started; null when none is running. */
  upSince: number | null
  lastEventAt: number | null
  lastLineAt: number | null
  eventsToday: number
  restartsToday: number
  lastError: string
  /** The last time it stopped (app quit, crash, stop), handed back on the next start so it can catch up. */
  downSince: number | null
  /** The last gap it caught up on: from, to, and how many events arrived in its first minute back. */
  lastGap: { from: number; to: number; caughtUp: number } | null
  /** Its secrets that have a value. */
  secretsSet: string[]
  /** When an `every` worker runs next. */
  nextRunAt: number | null
}

/** What a routine with kind `event` listens for (its spec, as JSON). */
export interface EventFilter {
  /** A worker id. */
  worker?: string
  source?: string
  /** An event name, `*` as a wildcard: "message.*". */
  event?: string
  /** Payload fields: a top-level or dotted path, and the text it must contain (case-insensitive). */
  match?: Record<string, string>
}

/** One line from a worker, understood. */
export type WorkerLine =
  | { type: 'ready' }
  | { type: 'alive' }
  | { type: 'event'; event: WorkerEventInput }
  | { type: 'cursor'; value: string }
  | { type: 'log'; level: WorkerLogLine['level']; text: string }

export interface WorkersApi {
  list(): Promise<WorkerInfo[]>
  /** Newest first. With a worker id, only that worker's events. */
  events(worker?: string, limit?: number): Promise<WorkerEvent[]>
  /** The last lines of its log, oldest first. */
  logs(id: string, limit?: number): Promise<WorkerLogLine[]>
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
  restart(id: string): Promise<void>
  remove(id: string): Promise<void>
  /** The person types a key for one of its secrets; it goes straight to the encrypted store. */
  setSecret(id: string, name: string, value: string): Promise<void>
  openFolder(id: string): Promise<void>
  /** Something about the workers or their events changed. */
  onChange(cb: () => void): () => void
}

export const WORKER_PAYLOAD_MAX = 32_000
export const WORKER_LINE_MAX = 256_000
/** Short enough that the app's secret file name (worker-<id>-<NAME>) stays within its limit. */
export const WORKER_SECRET_NAME = /^[A-Z][A-Z0-9_]{1,39}$/
export const WORKER_ID = /^w_[a-z0-9]{4,24}$/

const LEVELS = new Set(['info', 'warn', 'error'])

/**
 * One stdout line, understood. Null for an empty line. Anything that is not a valid contract line comes back as a
 * log line, so nothing a worker prints is lost and a bad line never crashes the supervisor.
 */
export function parseWorkerLine(raw: string): WorkerLine | null {
  const line = raw.trim()
  if (line === '') return null
  if (line.length > WORKER_LINE_MAX) return { type: 'log', level: 'warn', text: `Line too long (${line.length} characters), dropped.` }
  if (!line.startsWith('{')) return { type: 'log', level: 'info', text: line }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { type: 'log', level: 'info', text: line }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { type: 'log', level: 'info', text: line }
  const o = parsed as Record<string, unknown>
  switch (o['type']) {
    case 'ready':
      return { type: 'ready' }
    case 'alive':
      return { type: 'alive' }
    case 'cursor':
      return typeof o['value'] === 'string' || typeof o['value'] === 'number'
        ? { type: 'cursor', value: String(o['value']).slice(0, 2000) }
        : { type: 'log', level: 'warn', text: 'A cursor line without a value was ignored.' }
    case 'log': {
      const level = typeof o['level'] === 'string' && LEVELS.has(o['level']) ? (o['level'] as WorkerLogLine['level']) : 'info'
      return { type: 'log', level, text: typeof o['text'] === 'string' ? o['text'] : JSON.stringify(o['text'] ?? '') }
    }
    case 'event': {
      const problem = eventProblem(o)
      if (problem !== null) return { type: 'log', level: 'warn', text: `Event ignored: ${problem}` }
      const seenAt = typeof o['seenAt'] === 'number' && Number.isFinite(o['seenAt']) ? (o['seenAt'] as number) : undefined
      return {
        type: 'event',
        event: {
          source: (o['source'] as string).trim(),
          event: (o['event'] as string).trim(),
          payload: o['payload'] ?? null,
          dedupeKey: String(o['dedupeKey']).trim().slice(0, 500),
          ...(seenAt === undefined ? {} : { seenAt }),
        },
      }
    }
    default:
      return { type: 'log', level: 'info', text: line }
  }
}

function eventProblem(o: Record<string, unknown>): string | null {
  if (typeof o['source'] !== 'string' || o['source'].trim() === '') return 'it needs a source'
  if (typeof o['event'] !== 'string' || o['event'].trim() === '') return 'it needs an event name'
  const key = o['dedupeKey']
  if ((typeof key !== 'string' && typeof key !== 'number') || String(key).trim() === '') return 'it needs a dedupeKey'
  return null
}

/** The payload as stored: JSON text, cut to size with a marker when it is too big. */
export function payloadText(payload: unknown): string {
  let text: string
  try {
    text = JSON.stringify(payload ?? null)
  } catch {
    text = JSON.stringify(String(payload))
  }
  if (text.length <= WORKER_PAYLOAD_MAX) return text
  return JSON.stringify({ _cut: true, _length: text.length, head: text.slice(0, WORKER_PAYLOAD_MAX - 200) })
}

/** A routine's event filter from its spec, or a plain line saying what is wrong. */
export function parseEventFilter(spec: string): EventFilter | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(spec)
  } catch {
    return 'spec must be JSON, like {"worker":"w_ab12","event":"message.*"}'
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'spec must be a JSON object'
  const o = parsed as Record<string, unknown>
  const filter: EventFilter = {}
  for (const key of ['worker', 'source', 'event'] as const) {
    const value = o[key]
    if (value === undefined || value === '') continue
    if (typeof value !== 'string') return `${key} must be text`
    filter[key] = value.trim()
  }
  if (o['match'] !== undefined) {
    if (typeof o['match'] !== 'object' || o['match'] === null || Array.isArray(o['match'])) return 'match must be an object of field: text'
    const match: Record<string, string> = {}
    for (const [field, value] of Object.entries(o['match'] as Record<string, unknown>)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return `match.${field} must be text`
      match[field] = String(value)
    }
    if (Object.keys(match).length > 0) filter.match = match
  }
  if (filter.worker === undefined && filter.source === undefined) return 'name a worker or a source, so the routine does not take every event'
  return filter
}

/** Does this event belong to the routine with this filter? */
export function matchesEvent(filter: EventFilter, event: Pick<WorkerEvent, 'worker' | 'source' | 'event' | 'payload'>): boolean {
  if (filter.worker !== undefined && filter.worker !== event.worker) return false
  if (filter.source !== undefined && filter.source.toLowerCase() !== event.source.toLowerCase()) return false
  if (filter.event !== undefined && !wildcard(filter.event).test(event.event)) return false
  if (filter.match !== undefined) {
    let payload: unknown
    try {
      payload = JSON.parse(event.payload)
    } catch {
      return false
    }
    for (const [path, wanted] of Object.entries(filter.match)) {
      const value = pathValue(payload, path)
      if (value === undefined || value === null) return false
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      if (!text.toLowerCase().includes(wanted.toLowerCase())) return false
    }
  }
  return true
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`, 'i')
}

function pathValue(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** The filter in plain words, for the Routines page and routine_list. */
export function describeEventFilter(spec: string, workerName?: (id: string) => string | undefined): string {
  const filter = parseEventFilter(spec)
  if (typeof filter === 'string') return 'When an event arrives (the filter is not valid)'
  const from = filter.worker !== undefined ? (workerName?.(filter.worker) ?? filter.worker) : (filter.source ?? 'a worker')
  const what = filter.event === undefined || filter.event === '*' ? 'sends anything' : `sends ${filter.event}`
  const extra = filter.match === undefined ? '' : ` where ${Object.entries(filter.match).map(([k, v]) => `${k} has "${v}"`).join(' and ')}`
  return `When ${from} ${what}${extra}`
}

/** A manifest from worker.json text, or a line saying what is wrong with it. */
export function parseManifest(text: string, id: string): WorkerManifest | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'worker.json is not valid JSON'
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'worker.json must be an object'
  return normaliseManifest(parsed as Record<string, unknown>, id)
}

export function normaliseManifest(o: Record<string, unknown>, id: string): WorkerManifest | string {
  const name = typeof o['name'] === 'string' ? o['name'].trim() : ''
  if (name === '') return 'a worker needs a name'
  const entry = typeof o['entry'] === 'string' ? o['entry'].trim() : ''
  if (entry === '') return 'a worker needs an entry file'
  const runtime = o['runtime'] ?? 'node'
  if (runtime !== 'node' && runtime !== 'python' && runtime !== 'powershell' && runtime !== 'command') return 'runtime must be node, python, powershell or command'
  if (runtime !== 'command' && (entry.includes('..') || /^([a-zA-Z]:|[/\\])/.test(entry))) return 'entry must be a file inside the worker folder'
  const mode = o['mode'] ?? 'stay'
  if (mode !== 'stay' && mode !== 'every') return 'mode must be stay or every'
  let everyMinutes: number | null = null
  if (mode === 'every') {
    const minutes = Number(o['everyMinutes'])
    if (!Number.isFinite(minutes) || minutes < 1) return 'an every worker needs everyMinutes, at least 1'
    everyMinutes = Math.round(minutes)
  }
  const secrets = Array.isArray(o['secrets']) ? o['secrets'].filter((s): s is string => typeof s === 'string').map((s) => s.trim()) : []
  const bad = secrets.find((s) => !WORKER_SECRET_NAME.test(s))
  if (bad !== undefined) return `secret names are CAPITALS_AND_UNDERSCORES: "${bad}" is not`
  const args = Array.isArray(o['args']) ? o['args'].filter((a): a is string => typeof a === 'string') : []
  const now = Date.now()
  return {
    id,
    name: name.slice(0, 80),
    about: typeof o['about'] === 'string' ? o['about'].trim().slice(0, 500) : '',
    entry,
    runtime,
    args,
    mode,
    everyMinutes,
    secrets: [...new Set(secrets)],
    enabled: o['enabled'] !== false,
    createdAt: typeof o['createdAt'] === 'number' ? o['createdAt'] : now,
    updatedAt: typeof o['updatedAt'] === 'number' ? o['updatedAt'] : now,
  }
}
