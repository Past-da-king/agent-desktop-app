/**
 * Offload (docs/devices-protocol.md s12): helpers, project chats and routine runs placed on another brain, so the
 * computer the person is using keeps its resources, while everything looks and behaves there as if it ran locally.
 *
 * It rides on what replication already carries. The helper's own rows (its card, steps, transcript) are written by
 * the brain that runs it and replicate back, so every screen shows them like a local helper's. What is new is one
 * synced row kind, `job`:
 *  - `node` rows: every brain beats its own capacity (the AI accounts it can run, how many helpers it takes from
 *    other devices, how many run now, whether it has a browser) every 20 s. A brain with no fresh row gets nothing.
 *  - `msg` rows: one message to one brain about one helper or chat: start, steer, push, stop, answer, decide (to the
 *    brain running it), result and bounce (back to the brain that placed it), post and chatstop (a project chat that
 *    runs elsewhere). The receiver marks each `done` once handled.
 *  - `claim` rows: which brain owns a project chat (`chat-<id>`), and which brain runs one slot of a routine.
 * Exactly one brain runs a helper: the one that holds its job lease (runtime/turns.ts). A runner that dies is taken
 * over by the lease failover, and a start nobody took is taken back here.
 *
 * Nothing here is on while Devices is off (no self id), or while no other brain beats a fresh node row: both apps
 * then work exactly as before, alone.
 */
import { hostname } from 'node:os'

import { MAIN_CHAT, type DataChange, type DeviceRow, type JobRow } from '@agent/core'

import type { DataStore } from './data'

export const NODE_BEAT_MS = 20_000
/** A node row older than this is a brain that is gone or switched off: nothing is placed on it. */
export const NODE_FRESH_MS = 75_000
/**
 * The safety sweep for messages. A message is handled the moment its row arrives (store.onChange); the sweep only
 * catches one whose event was missed. It was a read every 3 s, all day, on an idle app.
 */
export const SCAN_MS = 60_000
/** A message that could not be handled yet (its card has not arrived) is looked at again this soon. */
export const RETRY_SCAN_MS = 3_000
/** A start nobody took within this long (no job lease) is run where it was placed from. */
export const TAKE_BACK_MS = 45_000
/** A routine slot the preferred brain has not claimed within this long is run by whichever brain sees it next. */
export const ROUTINE_GRACE_MS = 90_000
/** Handled messages are kept this long, then removed. */
const KEEP_DONE_MS = 24 * 3_600_000

export interface NodeCapacity {
  name: string
  kind: string
  /** The AI accounts (ids) this brain can run now: a key it holds, or a plan it is signed in to. */
  accounts: string[]
  /** Most helpers it takes from other devices at once; 0 = none, NO_LIMIT_CAP = no limit (the default). */
  cap: number
  /** Helpers running on it now. */
  active: number
  /** It has a browser for the browser tools (only its own sign-ins, none of another computer's). */
  browser: boolean
}

export type JobOp = 'start' | 'steer' | 'push' | 'stop' | 'answer' | 'decide' | 'result' | 'bounce' | 'post' | 'chatstop'

export interface PlaceRequest {
  /** What the job is: its brief (and label). */
  text: string
  /** The AI account it runs on. */
  account: string
  /** Where it was asked to run: '' or 'best', 'here', or a device by name or id. */
  device?: string
  /** It works in a project folder on this computer. */
  localFolder?: boolean
  /** This computer's own names (device name, host name): a brief that names one needs this computer. Filled in by place(). */
  selfNames?: string[]
  /**
   * Why this computer is busy now ('' or unset when it is not): short of memory or disk, CPU high, or more helpers
   * than it runs comfortably. A job asked to run "here" that does not need this computer then goes to a free server.
   */
  busy?: string
}

/** Does the text name this device (its whole name, not part of a word)? Names under 3 characters never count. */
export function namesDevice(text: string, name: string): boolean {
  const wanted = name.trim()
  if (wanted.length < 3) return false
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, 'i').test(text)
}

export interface PlaceCandidate {
  id: string
  name: string
  kind: string
  up: boolean
  capacity: NodeCapacity
}

export interface PlaceResult {
  /** The brain to run it on, or null for here. */
  device: string | null
  name: string
  why: string
}

/** Words for "on this computer". */
const HERE = new Set(['here', 'this', 'local', 'this computer', 'this device', 'here only', 'pc', 'this pc'])
const BEST = new Set(['', 'best', 'auto', 'any', 'anywhere'])

/**
 * A job that needs the computer it was asked on: its files and folders, its screen, its signed-in browser, its
 * installed apps. Everything else may run elsewhere (research, reading pages, writing, code that lives in a repo
 * the other brain has, long jobs).
 */
export const NEEDS_HERE =
  /([a-z]:\\|\\\\wsl|%appdata%|\b(this (computer|pc|laptop|machine|device)|my (computer|pc|laptop|desktop|screen|files?|folders?|downloads|documents|pictures|browser)|downloads folder|desktop app|on (the|my) screen|screenshots?|clipboard|signed[- ]in|logged[- ]in|log ?in to|sign ?in to|install (it|the app|on)|open (it|the app|the file|the folder)|webcam|microphone|printer|usb|bluetooth|window(s)? (settings|explorer)|in the app|app window|settings page)\b)/i

/** Jobs that are worth sending away first (only for the reason line; every other job may go too). */
export const HEAVY =
  /\b(research|scrape|scraping|crawl|compare|survey|analy[sz]e|build|compile|test suite|run the tests|deploy|benchmark|download|transcribe|summari[sz]e|report|audit|migrat|index|search the web|find out)\b/i

/** Matches a device by id or name, forgiving about case and spaces. */
export function matchDevice<T extends { id: string; name: string }>(list: T[], ref: string): T | null {
  const wanted = ref.trim().toLowerCase()
  if (wanted === '') return null
  return (
    list.find((each) => each.id.toLowerCase() === wanted) ??
    list.find((each) => each.name.toLowerCase() === wanted) ??
    list.find((each) => each.name.toLowerCase().includes(wanted)) ??
    null
  )
}

function fits(candidate: PlaceCandidate, account: string): boolean {
  const cap = candidate.capacity
  return candidate.up && cap.cap > 0 && cap.active < cap.cap && cap.accounts.includes(account)
}

function load(candidate: PlaceCandidate): number {
  return candidate.capacity.cap <= 0 ? 1 : candidate.capacity.active / candidate.capacity.cap
}

/**
 * Where one job runs. `mode` is this brain's setting (helpersRunOn: best, here, or a device id); a device the job
 * names wins over it. 'best': a job that needs this computer stays; anything else goes to a linked server that can
 * run its AI and has room (the least busy first); with none, it stays. A server only hands work to a computer when
 * the job needs that computer. Never a brain that cannot run the job's AI, is offline, or is full.
 */
export function choosePlacement(req: PlaceRequest, candidates: PlaceCandidate[], selfKind: string, mode: string): PlaceResult {
  const here = (why: string): PlaceResult => ({ device: null, name: '', why })
  const named = (req.device ?? '').trim()
  const want = named === '' ? mode.trim() : named
  const lower = want.toLowerCase()
  const needsHere = req.localFolder === true || NEEDS_HERE.test(req.text) || (req.selfNames ?? []).some((each) => namesDevice(req.text, each))
  if (HERE.has(lower)) {
    // Asked for "here" on this one job (not the person's setting), the computer is busy, and nothing in the job needs
    // it: a free server takes it, so this computer keeps working (30 Oct 2026, hangs under eleven helpers).
    const busy = (req.busy ?? '').trim()
    if (named !== '' && busy !== '' && !needsHere && selfKind !== 'server') {
      const server = candidates.filter((each) => each.kind === 'server' && fits(each, req.account)).sort((a, b) => load(a) - load(b))[0]
      if (server !== undefined) return { device: server.id, name: server.name, why: `${busy}, and it does not need this computer` }
    }
    return here('asked to run here')
  }

  if (!BEST.has(lower)) {
    const found = matchDevice(candidates, want)
    if (found === null) return here(named === '' ? 'the device set for helpers is not linked' : `no linked brain called ${want}`)
    if (!found.up) return here(`${found.name} is offline`)
    if (!found.capacity.accounts.includes(req.account)) return here(`${found.name} cannot run that AI`)
    if (found.capacity.cap <= 0) return here(`${found.name} takes no work from other devices`)
    if (found.capacity.active >= found.capacity.cap) return here(`${found.name} is full`)
    return { device: found.id, name: found.name, why: 'asked for' }
  }

  if (needsHere) {
    if (selfKind !== 'server') return here('it needs this computer')
    const computer = candidates.filter((each) => each.kind !== 'server' && fits(each, req.account)).sort((a, b) => load(a) - load(b))[0]
    return computer === undefined ? here('no computer free for it') : { device: computer.id, name: computer.name, why: 'it needs a computer' }
  }
  if (selfKind === 'server') return here('a server runs its own work')
  const server = candidates.filter((each) => each.kind === 'server' && fits(each, req.account)).sort((a, b) => load(a) - load(b))[0]
  if (server === undefined) return here('no server free for it')
  return { device: server.id, name: server.name, why: HEAVY.test(req.text) ? 'heavy work' : 'spares this computer' }
}

export interface OffloadDeps {
  store: DataStore & { onChange(listener: (change: DataChange) => void): () => void }
  /** This brain's device id while Devices is on, '' while it is off (then nothing is placed or taken). */
  selfId: () => string
  /** Every id that has meant this brain. */
  isSelf: (id: string) => boolean
  /** Is that brain reachable now (its replication link is up)? */
  reachable: (id: string) => boolean
  /** This brain's capacity now. */
  capacity: () => NodeCapacity
  /** Settings helpersRunOn: best, here, or a device id. */
  mode: () => string
  /** One message for this brain. False: not ready for it yet (its rows have not arrived), try again later. */
  handle: (msg: JobRow) => Promise<boolean>
  now?: () => number
  beatMs?: number
  scanMs?: number
  /** How soon a message that could not be handled yet is looked at again. */
  retryScanMs?: number
  log?: (line: string, detail?: Record<string, unknown>) => void
}

export class Offload {
  private readonly now: () => number
  private offChange: (() => void) | null = null
  private beatTimer: ReturnType<typeof setInterval> | null = null
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly handling = new Set<string>()
  private scanning: Promise<void> | null = null
  private rescan = false
  /** Routine slots this brain saw due but left to the preferred brain, and since when. */
  private readonly routineWait = new Map<string, number>()

  constructor(private readonly deps: OffloadDeps) {
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.offChange !== null) return
    this.offChange = this.deps.store.onChange((change) => {
      if (change.entity !== 'job') return
      const row = change.row as JobRow | undefined
      if (change.reset === true || (row !== undefined && row.kind === 'msg' && row.status === 'sent' && this.deps.isSelf(row.device))) void this.scan()
    })
    this.beatTimer = setInterval(() => void this.beat().catch(() => undefined), this.deps.beatMs ?? NODE_BEAT_MS)
    this.beatTimer.unref?.()
    this.scanTimer = setInterval(() => void this.scan(), this.deps.scanMs ?? SCAN_MS)
    this.scanTimer.unref?.()
    void this.beat().catch(() => undefined)
    void this.scan()
  }

  stop(): void {
    this.offChange?.()
    this.offChange = null
    if (this.beatTimer !== null) clearInterval(this.beatTimer)
    if (this.scanTimer !== null) clearInterval(this.scanTimer)
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.beatTimer = null
    this.scanTimer = null
  }

  selfId(): string {
    return this.deps.selfId()
  }

  isSelf(id: string): boolean {
    return id !== '' && this.deps.isSelf(id)
  }

  up(id: string): boolean {
    return id !== '' && !this.isSelf(id) && this.deps.reachable(id)
  }

  /** Writes this brain's node row now (also every 20 s). */
  async beat(): Promise<void> {
    const self = this.deps.selfId()
    if (self === '') return
    const capacity = this.deps.capacity()
    await this.deps.store.upsert('job', { id: `node-${self}`, kind: 'node', device: self, from: self, status: 'on', info: JSON.stringify(capacity), at: this.now() })
    await this.prune().catch(() => undefined)
  }

  /** The other brains that could take work, with their capacity. */
  async candidates(): Promise<PlaceCandidate[]> {
    const devices = (await this.deps.store.list('device')).filter((row) => !row.revoked && row.roles.includes('brain') && !this.isSelf(row.id))
    if (devices.length === 0) return []
    const nodes = await this.rows('node')
    const now = this.now()
    const out: PlaceCandidate[] = []
    for (const device of devices) {
      const node = nodes.find((row) => row.device === device.id)
      if (node === undefined) continue
      const capacity = parseCapacity(node.info)
      if (capacity === null) continue
      out.push({ id: device.id, name: device.name || capacity.name, kind: device.kind, up: now - node.at < NODE_FRESH_MS && this.deps.reachable(device.id), capacity })
    }
    return out
  }

  /** Where a job runs: another brain's id and name, or null for here. */
  async place(req: PlaceRequest): Promise<PlaceResult> {
    if (this.deps.selfId() === '') return { device: null, name: '', why: 'Devices is off' }
    const candidates = await this.candidates()
    if (candidates.length === 0 && (req.device ?? '').trim() === '') return { device: null, name: '', why: 'no other brain' }
    const selfRow = await this.selfRow()
    const selfKind = selfRow?.kind ?? this.deps.capacity().kind
    const selfNames = req.selfNames ?? [...new Set([selfRow?.name ?? '', this.deps.capacity().name, hostname()].filter((each) => each !== ''))]
    const result = choosePlacement({ ...req, selfNames }, candidates, selfKind, this.deps.mode())
    this.deps.log?.('Placement', { to: result.device === null ? 'here' : 'other', why: result.why })
    return result
  }

  /** A message to one brain. */
  async send(to: string, op: JobOp, helper: string, extra: { text?: string; item?: string; info?: string } = {}): Promise<void> {
    const self = this.deps.selfId()
    await this.deps.store.upsert('job', {
      kind: 'msg',
      device: to,
      from: self,
      helper,
      op,
      text: extra.text ?? '',
      item: extra.item ?? '',
      info: extra.info ?? '',
      status: 'sent',
      at: this.now(),
    })
  }

  /** Handles the messages waiting for this brain, oldest first. */
  scan(): Promise<void> {
    if (this.scanning !== null) {
      this.rescan = true
      return this.scanning
    }
    const run = async (): Promise<void> => {
      do {
        this.rescan = false
        if (this.deps.selfId() === '') return
        const waiting = (await this.rows('msg'))
          .filter((row) => row.status === 'sent' && this.isSelf(row.device) && !this.handling.has(row.id))
          .sort((a, b) => a.at - b.at || a.createdAt - b.createdAt)
        for (const row of waiting) {
          this.handling.add(row.id)
          try {
            const done = await this.deps.handle(row)
            if (!done) this.scanSoon()
            if (done) await this.deps.store.upsert('job', { id: row.id, status: 'done', at: this.now() })
          } catch (error) {
            this.deps.log?.('Offload message failed', { op: row.op, message: error instanceof Error ? error.message : String(error) })
            await this.deps.store.upsert('job', { id: row.id, status: 'done', at: this.now() }).catch(() => undefined)
          } finally {
            this.handling.delete(row.id)
          }
        }
      } while (this.rescan)
    }
    this.scanning = run().catch(() => undefined).finally(() => {
      this.scanning = null
    })
    return this.scanning
  }

  /** Something is still waiting to be handled: look again shortly, once (only while there is such a message). */
  private scanSoon(): void {
    if (this.retryTimer !== null || this.offChange === null) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.scan()
    }, this.deps.retryScanMs ?? RETRY_SCAN_MS)
    this.retryTimer.unref?.()
  }

  /** The brain holding a helper's job lease now (any status), or '' when it has none. */
  async leaseHolder(helperId: string): Promise<{ device: string; running: boolean }> {
    const lease = await this.deps.store.get('turn_lease', `job-${helperId}`)
    if (lease === null) return { device: '', running: false }
    return { device: lease.brainId, running: lease.status === 'running' || lease.status === 'interrupted' }
  }

  nameOf(id: string, devices: DeviceRow[]): string {
    return devices.find((row) => row.id === id)?.name ?? ''
  }

  async deviceName(id: string): Promise<string> {
    return this.nameOf(id, await this.deps.store.list('device'))
  }

  // ---- project chats ------------------------------------------------------------------------------------------

  /** Who runs a chat: `device` runs it, `from` placed it. Null: nobody else (it runs where it is used). */
  async chatOwner(chat: string): Promise<{ device: string; from: string } | null> {
    if (chat === MAIN_CHAT) return null
    const row = await this.deps.store.get('job', `chat-${chat}`)
    if (row === null || row.kind !== 'claim' || row.device === '') return null
    return { device: row.device, from: row.from }
  }

  /** `info`: what the chat carries from this brain, as JSON ({ shell }: this computer's commands-and-files choice). */
  async placeChat(chat: string, device: string, info = ''): Promise<void> {
    await this.deps.store.upsert('job', { id: `chat-${chat}`, kind: 'claim', device, from: this.deps.selfId(), helper: chat, op: 'chat', status: 'on', info, at: this.now() })
  }

  /** A project chat another brain placed here: the commands-and-files choice it carries, or undefined. */
  async placedChatShell(chat: string): Promise<'always' | 'ask' | 'never' | undefined> {
    const row = await this.deps.store.get('job', `chat-${chat}`)
    if (row === null || row.kind !== 'claim' || !this.isSelf(row.device) || row.from === '' || this.isSelf(row.from)) return undefined
    try {
      const shell = (JSON.parse(row.info) as { shell?: unknown }).shell
      return shell === 'always' || shell === 'ask' || shell === 'never' ? shell : undefined
    } catch {
      return undefined
    }
  }

  /**
   * A message going into `chat` from this brain: the brain it should go to instead, or null to run it here.
   * A project chat placed on another brain gets its messages there; the main chat, written to from a project chat
   * that runs here for another brain, gets them back on the brain that placed it.
   */
  async routeChat(chat: string, fromChat?: string): Promise<string | null> {
    if (this.deps.selfId() === '') return null
    if (chat === MAIN_CHAT) {
      if (fromChat === undefined || fromChat === MAIN_CHAT) return null
      const owner = await this.chatOwner(fromChat)
      if (owner === null || !this.isSelf(owner.device) || owner.from === '' || this.isSelf(owner.from)) return null
      return owner.from
    }
    const owner = await this.chatOwner(chat)
    if (owner === null || this.isSelf(owner.device)) return null
    return this.up(owner.device) ? owner.device : null
  }

  // ---- routines -----------------------------------------------------------------------------------------------

  /**
   * Whether this brain runs one due slot of a routine (every brain holds the same routines). The preferred brain
   * (placement of the routine's prompt from here) claims at once; any other brain waits ROUTINE_GRACE_MS for a
   * claim and then claims itself, so a slot is never lost when the preferred one is down. The newest claim wins;
   * a claim is read again after a short settle so two brains that claimed together agree.
   */
  async claimRoutine(triggerId: string, slot: string, req: PlaceRequest, settleMs = 2_500): Promise<boolean> {
    const self = this.deps.selfId()
    if (self === '') return true
    const others = await this.candidates()
    if (others.length === 0) return true
    const id = `routine-${triggerId}@${slot}`
    const existing = await this.deps.store.get('job', id)
    if (existing !== null && existing.device !== '') return this.isSelf(existing.device) && existing.status !== 'done'
    const placed = await this.place(req)
    if (placed.device !== null && others.some((each) => each.id === placed.device && each.up)) {
      const since = this.routineWait.get(id) ?? this.now()
      this.routineWait.set(id, since)
      if (this.now() - since < ROUTINE_GRACE_MS) return false
    }
    this.routineWait.delete(id)
    await this.deps.store.upsert('job', { id, kind: 'claim', device: self, from: self, helper: `${triggerId}@${slot}`, op: 'routine', status: 'on', at: this.now() })
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs))
    const after = await this.deps.store.get('job', id)
    return after !== null && this.isSelf(after.device)
  }

  // ---- inside ---------------------------------------------------------------------------------------------------

  private async selfRow(): Promise<DeviceRow | null> {
    const self = this.deps.selfId()
    return self === '' ? null : this.deps.store.get('device', self)
  }

  private async rows(kind: JobRow['kind']): Promise<JobRow[]> {
    const store = this.deps.store
    const rows = store.listWhere !== undefined ? await store.listWhere('job', { kind }) : (await store.list('job')).filter((row) => row.kind === kind)
    return rows
  }

  /** Messages handled a day ago are removed by the brain that received them. */
  private async prune(): Promise<void> {
    const cutoff = this.now() - KEEP_DONE_MS
    for (const row of await this.rows('msg')) {
      if (row.status === 'done' && row.at < cutoff && this.isSelf(row.device)) await this.deps.store.remove('job', row.id)
    }
  }
}

export function parseCapacity(info: string): NodeCapacity | null {
  try {
    const raw = JSON.parse(info) as Record<string, unknown>
    if (typeof raw !== 'object' || raw === null) return null
    const accounts = Array.isArray(raw['accounts']) ? raw['accounts'].filter((each): each is string => typeof each === 'string') : []
    const number = (key: string, fallback: number): number => (typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key] as number) : fallback)
    return {
      name: typeof raw['name'] === 'string' ? raw['name'] : '',
      kind: typeof raw['kind'] === 'string' ? raw['kind'] : 'desktop',
      accounts,
      cap: number('cap', 0),
      active: number('active', 0),
      browser: raw['browser'] === true,
    }
  } catch {
    return null
  }
}

/** A run failed because its AI is not signed in or its key was refused here: another brain may still run it. */
export const CANNOT_RUN_HERE =
  /not signed in|sign ?in again|log ?in|logged out|oauth session expired|could not be refreshed|not authenticated|authentication failed|failed to authenticate|invalid api key|unauthori[sz]ed|\b401\b|has no api key|cannot run on a plan/i
