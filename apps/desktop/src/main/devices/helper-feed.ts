/**
 * The helper cards a linked device shows (protocol: RPC `helpers.cards` for the list now, event
 * `agent:evt:helpers.cards` with the whole new list each time it changes). This node is the one source of truth: the
 * cards are built by shared/helper-cards.ts, the same model as the window's side panel, and a device only renders
 * them. Works the same in the desktop app and the headless node (both register it through main/ipc.ts).
 *
 * The feed starts on the first `helpers.cards` call, so a computer with nothing linked does no work for it. It keeps
 * the helper rows, their newest steps and the newest lines of each side chat in memory, follows every row change,
 * and sends a new list (debounced) only when it differs from the last one.
 */
import { MAIN_CHAT, type ChatItem, type DataChange, type HelperCardsSnapshot, type ProjectRow } from '@agent/core'

import { cardInfo, helperCards } from '../../shared/helper-cards'
import type { Store } from '../db'

/** How long a finished helper keeps its card, with its done line. */
export const FINISHED_KEEP_MS = 20 * 60_000
const DEBOUNCE_MS = 250
/** Steps older than this are not read at start (a helper still working that long has newer ones). */
const LOOKBACK_MS = 48 * 3_600_000
const KEEP_LINES = 30

export interface HelperFeedDeps {
  store: Pick<Store, 'list' | 'listWhere' | 'onChange'>
  emit(snapshot: HelperCardsSnapshot): void
  now?: () => number
  debounceMs?: number
  keepFinishedMs?: number
}

function metaOf(row: ChatItem): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(row.meta)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function text(meta: Record<string, unknown>, key: string): string {
  const value = meta[key]
  return typeof value === 'string' ? value : ''
}

/** Keeps a list of rows by id, oldest first, at most KEEP_LINES. */
function put(list: ChatItem[], row: ChatItem): ChatItem[] {
  const next = list.filter((each) => each.id !== row.id)
  next.push(row)
  next.sort((a, b) => a.createdAt - b.createdAt)
  return next.length > KEEP_LINES ? next.slice(next.length - KEEP_LINES) : next
}

export class HelperFeed {
  private readonly helpers = new Map<string, ChatItem>()
  /** A helper's steps, by helper id (activity rows carry meta.helper). */
  private readonly steps = new Map<string, ChatItem[]>()
  /** The newest lines (steps and replies) of each side chat, by chat id: a project agent card's steps. */
  private readonly chatLines = new Map<string, ChatItem[]>()
  private projects: ProjectRow[] = []
  private started: Promise<void> | null = null
  private offChange: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private expiry: ReturnType<typeof setTimeout> | null = null
  private last: HelperCardsSnapshot = { seq: 0, at: 0, cards: [] }
  private lastJson = ''
  private disposed = false

  constructor(private readonly deps: HelperFeedDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The cards right now (starts the feed on the first call). */
  async snapshot(): Promise<HelperCardsSnapshot> {
    await this.start()
    this.compute(false)
    return this.last
  }

  dispose(): void {
    this.disposed = true
    this.offChange?.()
    this.offChange = null
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.expiry !== null) clearTimeout(this.expiry)
    this.timer = null
    this.expiry = null
  }

  private start(): Promise<void> {
    if (this.started === null) {
      this.offChange = this.deps.store.onChange((change) => this.onChange(change))
      this.started = this.load()
    }
    return this.started
  }

  private async load(): Promise<void> {
    const store = this.deps.store
    const since = this.now() - LOOKBACK_MS
    const where = async (kind: string): Promise<ChatItem[]> =>
      store.listWhere !== undefined ? store.listWhere('chat_item', { kind, since }) : (await store.list('chat_item')).filter((row) => row.kind === kind && row.createdAt > since)
    const helperRows = store.listWhere !== undefined ? await store.listWhere('chat_item', { kind: 'helper' }) : (await store.list('chat_item')).filter((row) => row.kind === 'helper')
    this.helpers.clear()
    this.steps.clear()
    this.chatLines.clear()
    for (const row of helperRows) this.helpers.set(row.id, row)
    for (const row of [...(await where('activity')), ...(await where('agent'))]) this.index(row)
    this.projects = await store.list('project')
  }

  private index(row: ChatItem): boolean {
    if (row.kind === 'helper') {
      this.helpers.set(row.id, row)
      return true
    }
    if (row.kind !== 'activity' && row.kind !== 'agent') return false
    const meta = metaOf(row)
    const helper = row.kind === 'activity' ? text(meta, 'helper') : ''
    if (helper !== '') {
      this.steps.set(helper, put(this.steps.get(helper) ?? [], row))
      return true
    }
    const chat = text(meta, 'chat') || MAIN_CHAT
    if (chat === MAIN_CHAT) return false
    this.chatLines.set(chat, put(this.chatLines.get(chat) ?? [], row))
    return true
  }

  private onChange(change: DataChange): void {
    if (this.disposed) return
    if (change.entity === 'project') {
      void this.deps.store.list('project').then((projects) => {
        this.projects = projects
        this.schedule()
      })
      return
    }
    if (change.entity !== 'chat_item') return
    if (change.reset === true) {
      this.started = this.load().then(() => this.schedule())
      return
    }
    if (change.deleted === true || change.row === undefined) {
      const id = change.id ?? ''
      if (this.helpers.delete(id)) this.schedule()
      return
    }
    if (this.index(change.row as ChatItem)) this.schedule()
  }

  private schedule(): void {
    if (this.disposed || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.compute(true)
    }, this.deps.debounceMs ?? DEBOUNCE_MS)
    this.timer.unref?.()
  }

  /** Builds the list; a new one gets the next seq, and is sent when `send` is set. */
  private compute(send: boolean): void {
    const now = this.now()
    const keep = this.deps.keepFinishedMs ?? FINISHED_KEEP_MS
    const rows = [...this.helpers.values()]
    const items: ChatItem[] = [...rows]
    for (const row of rows) {
      const id = text(metaOf(row), 'id') || row.id
      items.push(...(this.steps.get(id) ?? []))
    }
    const cards = helperCards(items, this.projects, { keepFinishedMs: keep, now }).map((card) =>
      cardInfo(card, card.projectChat === '' ? [] : (this.chatLines.get(card.projectChat) ?? [])),
    )
    const json = JSON.stringify(cards)
    if (json !== this.lastJson) {
      this.lastJson = json
      this.last = { seq: this.last.seq + 1, at: now, cards }
      if (send) this.deps.emit(this.last)
    }
    this.planExpiry(cards.map((card) => card.endedAt).filter((at): at is number => at !== null), keep, now)
  }

  /** A finished card leaves when its time is up, without waiting for another change. */
  private planExpiry(ended: number[], keep: number, now: number): void {
    if (this.expiry !== null) clearTimeout(this.expiry)
    this.expiry = null
    if (ended.length === 0 || this.disposed) return
    const wait = Math.max(0, Math.min(...ended) + keep - now) + 50
    this.expiry = setTimeout(() => {
      this.expiry = null
      this.compute(true)
    }, wait)
    this.expiry.unref?.()
  }
}
