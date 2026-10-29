/**
 * Wake-ups on one node (desktop app or headless node): fires and withdraws for the agent tools, rings this computer
 * when a wake is for it, answers from his hands (the ringing screen, Settings, a linked phone), tells the linked
 * devices what is live, and puts `wakeup.fired` / `wakeup.acked` in the event store so routines can react.
 *
 * The rules are the pure model in shared/wakeups.ts. Every node reads the same synced rows and decides for itself
 * whether it rings, so a computer that loses its link keeps ringing what it already has, and an answer on any device
 * reaches every other one through replication (computers) or the wake events (phones).
 */
import { listWhere, type DataStore } from '../runtime/data'
import { isOrigin } from '../devices/origin'
import {
  ackRow,
  chooseTargets,
  DEFAULT_SNOOZE_MINUTES,
  foldWakes,
  inQuietHours,
  KEEP_MS,
  liveWakes,
  nextChange,
  planFire,
  planWithdraw,
  ringsHere,
  seenRow,
  shownTitle,
  snoozeRow,
  type FireInput,
  type Ringer,
  type WakeView,
} from '../../shared/wakeups'

/** One wake ringing on this computer (what the ring window shows). */
export interface RingItem {
  id: string
  severity: WakeView['severity']
  title: string
  whatToDo: string
  link: string
  sourceKind: string
  firedBy: string
  ringAt: number
  sound: boolean
  cancelled: boolean
}

/** What this computer does to ring (main/wakeups/ring-window.ts); none on a headless node. */
export interface WakeRinger {
  /** The full set ringing here now; empty stops the ring. */
  show(items: RingItem[]): void
}

/** What the linked devices are sent (event `wakeups.changed`, RPC `wakeups.list`). */
export interface WakeSnapshot {
  /** The sender's clock, so a device with a different clock can line up `ringAt`. */
  now: number
  from: string
  wakes: Array<Pick<WakeView, 'id' | 'severity' | 'whatToDo' | 'ringAt' | 'state' | 'cancelled' | 'targets' | 'seen' | 'firedBy'> & { title: string; link: string; sourceKind: string }>
  snoozeMinutes: number
  /** The sender's quiet hours ("22:00-07:00", '' none): a heads-up is silent in them on the phone too. */
  quietHours: string
}

export interface WakeEvent {
  source: string
  event: string
  payload: Record<string, unknown>
  dedupeKey: string
}

export const WAKEUPS_SOURCE = 'wakeups'
export const WAKEUPS_EVENT = 'wakeups.changed'

export interface WakeupServiceDeps {
  store: DataStore
  /** Store change notifications (db.ts Store.onChange). */
  onChange: (listener: (change?: { entity?: string }) => void) => () => void
  /** This node's device id ('' while Devices was never switched on). */
  selfId: () => string
  selfName: () => string
  /** This node can ring: a computer with a screen whose Settings say it rings. A headless node: false. */
  selfRings: () => boolean
  /** Every device row (computers and phones that can ring). */
  devices: () => Promise<Ringer[]>
  settings: () => { snoozeMinutes: number; quietHours: string }
  /** Seconds since the last keyboard or mouse input on this computer, or null. */
  idleSeconds?: () => number | null
  ringer?: WakeRinger
  /** Sends the live wakes to the linked devices. */
  broadcast?: (snapshot: WakeSnapshot) => void
  emitEvent?: (input: WakeEvent) => void
  now?: () => number
  /** Local minute of the day (quiet hours); default the computer's own clock. */
  minuteOfDay?: (at: number) => number
  log?: (line: string, detail?: Record<string, unknown>) => void
}

const LOCAL_ID = 'this-computer'
const ACTIVE_WINDOW_MS = 30 * 60_000

export class WakeupService {
  private timer: ReturnType<typeof setTimeout> | null = null
  private offChange: (() => void) | null = null
  private running = false
  private refreshing: Promise<void> | null = null
  private again = false
  private lastShown = ''
  private lastSent = ''
  private readonly now: () => number
  private readonly log: (line: string, detail?: Record<string, unknown>) => void
  /** Wake ids this node already reported as fired / answered (the event store also dedupes). */
  private readonly told = new Set<string>()

  constructor(private readonly deps: WakeupServiceDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => undefined)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.offChange = this.deps.onChange((change) => {
      if (change?.entity === undefined || change.entity === 'wakeup' || change.entity === 'device') this.kick()
    })
    void this.prune()
    this.kick()
  }

  stop(): void {
    this.running = false
    this.offChange?.()
    this.offChange = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.deps.ringer?.show([])
  }

  selfId(): string {
    return this.deps.selfId() || LOCAL_ID
  }

  // ---- agents: fire, withdraw, list (no answer, no silence) ------------------------------------------------------

  async fire(input: FireInput, firedBy: string): Promise<{ ok: boolean; id: string; message: string }> {
    const now = this.now()
    const rows = await this.deps.store.list('wakeup')
    const ringers = await this.ringers()
    const targets = chooseTargets(input.devices, ringers, { selfId: this.selfId(), selfRings: this.deps.selfRings(), activeDevice: await this.activeDevice(now) })
    const plan = planFire(input, rows, now, { firedBy, firedOn: this.selfId(), targets })
    if (plan.kind === 'refuse') {
      this.log('wakeups: refused', { firedBy, title: input.title, why: plan.message })
      return { ok: false, id: '', message: plan.message }
    }
    if (plan.kind === 'merge') {
      const existing = rows.find((row) => row.id === plan.id)
      await this.deps.store.upsert('wakeup', { ...existing, ...plan.row, id: plan.id })
      this.log('wakeups: merged', { id: plan.id, firedBy })
      this.kick()
      return { ok: true, id: plan.id, message: plan.message }
    }
    const saved = await this.deps.store.upsert('wakeup', plan.row)
    const view = foldWakes([saved], now)[0]
    const where = targets.length === 0 ? 'every device' : targets.map((id) => ringers.find((r) => r.id === id)?.name ?? id).join(', ')
    this.log('wakeups: fired', { id: saved.id, severity: input.severity, firedBy, at: saved.at, where })
    this.kick()
    const when = view !== undefined && view.state === 'pending' ? `rings at ${new Date(saved.at).toISOString()}` : 'ringing now'
    return { ok: true, id: saved.id, message: `Wake-up ${saved.id.slice(0, 8)} ${when} on ${where}. It rings until he answers on any device.` }
  }

  /** A test wake from his own button (Settings, the phone): rings exactly the devices given (empty: every device). */
  async fireTest(severity: FireInput['severity'], targets: string[], firedBy: string): Promise<string> {
    const now = this.now()
    const label = severity === 'critical' ? 'Critical' : severity === 'urgent' ? 'Urgent' : 'Heads-up'
    const plan = planFire(
      { severity, title: `Test: ${label} wake-up`, whatToDo: "This is a test of your wake-ups. Tap I'm on it to stop it, or Snooze.", source: { kind: 'test', ref: '', link: '' }, devices: targets.length === 0 ? 'all' : 'here', dedupeKey: '', at: null },
      await this.deps.store.list('wakeup'),
      now,
      { firedBy, firedOn: this.selfId(), targets },
    )
    if (plan.kind !== 'create') return plan.message
    const saved = await this.deps.store.upsert('wakeup', plan.row)
    this.log('wakeups: test fired', { id: saved.id, severity, targets })
    this.kick()
    return saved.id
  }

  async withdraw(ref: string): Promise<string> {
    const now = this.now()
    const views = foldWakes(await this.deps.store.list('wakeup'), now)
    const clean = ref.trim()
    const view = views.find((v) => v.id === clean || (clean.length >= 6 && v.id.startsWith(clean))) ?? views.find((v) => v.dedupeKey !== '' && v.dedupeKey === clean && v.state !== 'acked' && v.state !== 'withdrawn')
    if (view === undefined) return `No wake-up ${clean}.`
    const plan = planWithdraw(view, now)
    if (plan.row !== null) {
      const row = await this.deps.store.get('wakeup', view.id)
      await this.deps.store.upsert('wakeup', { ...row, ...plan.row, id: view.id })
      this.log('wakeups: withdraw', { id: view.id, result: plan.message })
      this.kick()
    }
    return plan.message
  }

  async list(limit = 20): Promise<WakeView[]> {
    return foldWakes(await this.deps.store.list('wakeup'), this.now()).slice(0, Math.max(1, Math.min(200, limit)))
  }

  // ---- his hands: the ringing screen, Settings, a linked phone ---------------------------------------------------

  async ack(id: string, by: { id: string; name: string }): Promise<boolean> {
    const view = await this.view(id)
    if (view === null || view.state === 'acked' || view.state === 'withdrawn') return false
    await this.deps.store.upsert('wakeup', ackRow(view.id, by, this.now()))
    this.log('wakeups: answered', { id: view.id, on: by.name })
    this.kick()
    return true
  }

  async snooze(id: string, by: { id: string; name: string }, minutes?: number): Promise<boolean> {
    const view = await this.view(id)
    if (view === null || (view.state !== 'ringing' && view.state !== 'snoozed')) return false
    const length = minutes ?? this.deps.settings().snoozeMinutes ?? DEFAULT_SNOOZE_MINUTES
    await this.deps.store.upsert('wakeup', snoozeRow(view, by, this.now(), length))
    this.log('wakeups: snoozed', { id: view.id, on: by.name, minutes: length })
    this.kick()
    return true
  }

  /** A device has it (it is ringing there): the delivery proof the 30 s fallback waits for. */
  async seen(id: string, deviceId: string): Promise<void> {
    const view = await this.view(id)
    if (view === null || view.seen[deviceId] !== undefined) return
    await this.deps.store.upsert('wakeup', seenRow(view.id, deviceId, this.now()))
  }

  /** What linked devices need: the live wakes, with this node's clock. */
  async snapshot(): Promise<WakeSnapshot> {
    const now = this.now()
    const views = liveWakes(foldWakes(await this.deps.store.list('wakeup'), now), now)
    return {
      now,
      from: this.selfId(),
      snoozeMinutes: this.deps.settings().snoozeMinutes,
      quietHours: this.deps.settings().quietHours,
      wakes: views.map((v) => ({
        id: v.id,
        severity: v.severity,
        title: shownTitle(v),
        whatToDo: v.whatToDo,
        link: v.source.link,
        sourceKind: v.source.kind,
        ringAt: v.ringAt,
        state: v.state,
        cancelled: v.cancelled,
        targets: v.targets,
        seen: v.seen,
        firedBy: v.firedBy,
      })),
    }
  }

  /** Read again now (a change, a timer, Settings). */
  kick(): void {
    if (!this.running) return
    if (this.refreshing !== null) {
      this.again = true
      return
    }
    this.refreshing = this.refresh()
      .catch((error: unknown) => this.log('wakeups: refresh failed', { message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        this.refreshing = null
        if (this.again) {
          this.again = false
          this.kick()
        }
      })
  }

  /** Settled: for tests. */
  async settled(): Promise<void> {
    while (this.refreshing !== null) await this.refreshing
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  private async refresh(): Promise<void> {
    const now = this.now()
    const views = foldWakes(await this.deps.store.list('wakeup'), now)
    const self = this.selfId()
    const quiet = inQuietHours(this.deps.settings().quietHours, (this.deps.minuteOfDay ?? localMinute)(now))

    // Ring here.
    const items: RingItem[] = []
    if (this.deps.selfRings()) {
      for (const view of views) {
        const decision = ringsHere(view, self, now, { quiet })
        if (!decision.ring) continue
        items.push({
          id: view.id,
          severity: view.severity,
          title: shownTitle(view),
          whatToDo: view.whatToDo,
          link: view.source.link,
          sourceKind: view.source.kind,
          firedBy: view.firedBy,
          ringAt: view.ringAt,
          sound: decision.sound,
          cancelled: view.cancelled,
        })
        if (view.seen[self] === undefined) await this.deps.store.upsert('wakeup', seenRow(view.id, self, now))
      }
    }
    const shown = JSON.stringify(items)
    if (shown !== this.lastShown) {
      this.lastShown = shown
      if (items.length > 0) this.log('wakeups: ringing here', { ids: items.map((i) => i.id) })
      this.deps.ringer?.show(items)
    }

    // Tell the linked devices when what is live changed.
    if (this.deps.broadcast !== undefined) {
      const snap = await this.snapshot()
      const key = JSON.stringify(snap.wakes)
      if (key !== this.lastSent) {
        this.lastSent = key
        this.deps.broadcast(snap)
      }
    }

    // Events for routines, from the node that fired the wake.
    for (const view of views) {
      if (view.firedOn !== self) continue
      if ((view.state === 'ringing' || view.state === 'acked') && !this.told.has(`f:${view.id}`)) {
        this.told.add(`f:${view.id}`)
        if (view.state === 'ringing') this.emit('wakeup.fired', view, `wakeup.fired:${view.id}`)
      }
      if (view.state === 'acked' && !this.told.has(`a:${view.id}`)) {
        this.told.add(`a:${view.id}`)
        this.emit('wakeup.acked', view, `wakeup.acked:${view.id}`)
      }
    }

    // The next moment anything changes.
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const due = views.map((v) => nextChange(v, now)).filter((t): t is number => t !== null)
    if (due.length > 0 && this.running) {
      const wait = Math.max(50, Math.min(...due) - now + 20)
      this.timer = setTimeout(() => this.kick(), Math.min(wait, 2_147_000_000))
      this.timer.unref?.()
    }
  }

  private emit(event: string, view: WakeView, dedupeKey: string): void {
    this.deps.emitEvent?.({
      source: WAKEUPS_SOURCE,
      event,
      dedupeKey,
      payload: {
        id: view.id,
        severity: view.severity,
        title: view.title,
        what_to_do: view.whatToDo,
        source: view.source,
        dedupe_key: view.dedupeKey,
        fired_by: view.firedBy,
        acked_at: view.ackedAt,
        acked_on: view.ackedBy,
      },
    })
  }

  private async view(id: string): Promise<WakeView | null> {
    const rows = await this.deps.store.list('wakeup')
    return foldWakes(rows, this.now()).find((v) => v.id === id) ?? null
  }

  private async ringers(): Promise<Ringer[]> {
    const list = (await this.deps.devices()).filter((d) => d.kind !== 'server')
    const self = this.selfId()
    if (this.deps.selfRings() && !list.some((d) => d.id === self)) list.push({ id: self, name: this.deps.selfName(), kind: 'desktop' })
    return list
  }

  /** The device he is using: his newest message's device in the last 30 min, or this computer if he is at it. */
  private async activeDevice(now: number): Promise<string | null> {
    let best: { id: string; at: number } | null = null
    try {
      const rows = await listWhere(this.deps.store, 'chat_item', { kind: 'user', since: now - ACTIVE_WINDOW_MS })
      for (const row of rows) {
        let meta: Record<string, unknown> = {}
        try {
          meta = JSON.parse(row.meta) as Record<string, unknown>
        } catch {
          continue
        }
        if (meta['via'] !== undefined) continue
        const origin = meta['origin']
        const id = isOrigin(origin) ? origin.deviceId : this.selfId()
        if (best === null || row.createdAt > best.at) best = { id, at: row.createdAt }
      }
    } catch {
      // No messages: fall through.
    }
    const idle = this.deps.selfRings() ? (this.deps.idleSeconds?.() ?? null) : null
    if (idle !== null && idle < 120) {
      const at = now - idle * 1000
      if (best === null || at >= best.at) best = { id: this.selfId(), at }
    }
    return best?.id ?? null
  }

  /** Rows older than 30 days go (the log keeps a month). */
  private async prune(): Promise<void> {
    try {
      const cut = this.now() - KEEP_MS
      const rows = await this.deps.store.list('wakeup')
      const old = new Set(rows.filter((r) => r.kind === 'wake' && Math.max(r.updatedAt, r.createdAt) < cut).map((r) => r.id))
      for (const row of rows) if (old.has(row.id) || old.has(row.wake)) await this.deps.store.remove('wakeup', row.id)
    } catch {
      // Next start tries again.
    }
  }
}

function localMinute(at: number): number {
  const d = new Date(at)
  return d.getHours() * 60 + d.getMinutes()
}

// ---- the one service of this process (tools and Settings reach it here) --------------------------------------------

let current: WakeupService | null = null

export function setWakeups(service: WakeupService | null): void {
  current = service
}

export function getWakeups(): WakeupService | null {
  return current
}
