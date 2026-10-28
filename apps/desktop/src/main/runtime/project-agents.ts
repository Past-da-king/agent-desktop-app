/**
 * A project agent shown like a helper in the MAIN chat (22 Oct 2026): when the main agent hands work to a project
 * chat (project_chat_start / project_chat_send), a `helper` row in the main chat stands for that project's agent. Its
 * meta carries the project (id, name, icon glyph, colour, picture) and the live status line (state, summary), kept up
 * to date as the project chat works (its activities, its helpers, its replies) and closed when it is done. Any screen
 * that shows main-chat helper rows (the window, a phone) shows it, with the project's icon.
 *
 * Row id: `pa-<project chat id>`, so one row per project chat; sending it more work opens the same row again.
 */
import { MAIN_CHAT, type ChatItem, type DataChange, type ProjectRow, type RunState } from '@agent/core'

import type { DataStore } from './data'

const MAX_SUMMARY = 140
const CHECK_MS = 2_000
/**
 * A followed chat whose rows did not change is read again only this often (28 Oct 2026: reading every followed
 * chat's rows every 2 s, each read a scan of all chat rows, held the main thread and froze the window).
 */
const RECHECK_MS = 60_000
/** The row kinds the close check needs: never a chat's activity steps, which hold nearly all of its bytes. */
const CHECK_KINDS = ['helper', 'agent', 'notice']
/** After a restart, how long a followed project chat gets for its turn lease to resume it before it can be closed. */
const RESUME_GRACE_MS = 30_000

export interface ProjectAgentDeps {
  store: DataStore & { onChange(listener: (change: DataChange) => void): () => void }
  /** Whether a chat is running and what waits on the person in it (runner.state). */
  state: (chat: string) => RunState
  /** Tell the window to redraw (a chat_changed event for the main chat). */
  changed?: () => void
  now?: () => number
  checkMs?: number
  resumeGraceMs?: number
}

export interface ProjectMeta {
  id: string
  name: string
  glyph: string
  color: string
  image?: string
}

export function projectMeta(project: ProjectRow): ProjectMeta {
  return {
    id: project.id,
    name: project.name,
    glyph: project.icon?.glyph ?? 'folder',
    color: project.icon?.color ?? 'iris',
    ...(typeof project.icon?.image === 'string' && project.icon.image !== '' ? { image: project.icon.image } : {}),
  }
}

export const rowIdFor = (chat: string): string => `pa-${chat}`

export class ProjectAgentRows {
  private readonly tracked = new Set<string>()
  /** Chats followed again after a restart, and until when they may not be closed (their lease is resuming them). */
  private readonly resuming = new Map<string, number>()
  /** Followed chats that changed (or went idle) since their rows were last read; only these are read again. */
  private readonly dirty = new Set<string>()
  /** When each followed chat's rows were last read: a quiet chat is read again only after RECHECK_MS. */
  private readonly checkedAt = new Map<string, number>()
  private readonly offChange: () => void
  private timer: ReturnType<typeof setInterval> | null = null
  private writing: Promise<unknown> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly deps: ProjectAgentDeps) {
    this.now = deps.now ?? Date.now
    this.offChange = deps.store.onChange((change) => {
      if (change.entity !== 'chat_item') return
      if (change.row === undefined) {
        // A reset or a removal: any followed chat may have changed.
        for (const chat of this.tracked) this.dirty.add(chat)
        return
      }
      const row = change.row as ChatItem
      const chat = chatOf(row)
      if (chat !== MAIN_CHAT && this.tracked.has(chat)) {
        this.dirty.add(chat)
        this.serial(() => this.onRow(chat, row))
      }
    })
  }

  /** On start: rows left working by a crash are followed again (the turn lease resumes their chats). */
  async restore(): Promise<void> {
    for (const row of await this.deps.store.listWhere?.('chat_item', { kind: 'helper', chat: MAIN_CHAT }) ?? []) {
      const meta = parse(row.meta)
      if (row.id.startsWith('pa-') && meta['state'] === 'working' && typeof meta['projectChat'] === 'string') {
        this.resuming.set(meta['projectChat'], this.now() + (this.deps.resumeGraceMs ?? RESUME_GRACE_MS))
        this.follow(meta['projectChat'])
      }
    }
  }

  dispose(): void {
    this.offChange()
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** The main agent handed `brief` to a project chat. */
  delegated(chat: string, project: ProjectRow, brief: string): Promise<void> {
    return this.serial(async () => {
      const id = rowIdFor(chat)
      const existing = await this.deps.store.get('chat_item', id)
      const old = existing === null ? {} : parse(existing.meta)
      await this.deps.store.upsert('chat_item', {
        id,
        kind: 'helper',
        text: existing?.text ?? brief,
        meta: JSON.stringify({
          ...old,
          id,
          label: project.name,
          state: 'working',
          summary: 'Starting',
          queued: false,
          startedAt: this.now(),
          endedAt: null,
          result: '',
          project: projectMeta(project),
          projectChat: chat,
          lastBrief: brief.slice(0, 600),
        }),
      })
      this.deps.changed?.()
      this.follow(chat)
    })
  }

  private follow(chat: string): void {
    this.tracked.add(chat)
    this.dirty.add(chat)
    if (this.timer === null) {
      this.timer = setInterval(() => this.serial(() => this.checkAll()), this.deps.checkMs ?? CHECK_MS)
      this.timer.unref?.()
    }
  }

  /** Something happened in a followed project chat: its newest line becomes the status line. */
  private async onRow(chat: string, row: ChatItem): Promise<void> {
    const meta = parse(row.meta)
    let summary = ''
    if (row.kind === 'activity') summary = row.text
    else if (row.kind === 'helper') summary = `${String(meta['label'] ?? 'Helper')}: ${String(meta['summary'] ?? meta['state'] ?? '')}`
    else if (row.kind === 'agent') summary = row.text
    else if (row.kind === 'question' || row.kind === 'approval') summary = 'Waiting for you'
    if (summary.trim() === '') return
    await this.patch(chat, { summary: clip(summary), ...(row.kind === 'agent' ? { result: row.text.slice(0, 6000) } : {}) }, true)
  }

  /** Close the rows whose project chat has finished: not running, nothing waiting, no helper still working. */
  private async checkAll(): Promise<void> {
    for (const chat of [...this.tracked]) {
      const state = this.deps.state(chat)
      if (state.running || state.waiting.length > 0) {
        this.resuming.delete(chat)
        // Read it once it goes quiet.
        this.dirty.add(chat)
        continue
      }
      if ((this.resuming.get(chat) ?? 0) > this.now()) continue
      this.resuming.delete(chat)
      if (!this.dirty.has(chat) && this.now() - (this.checkedAt.get(chat) ?? 0) < RECHECK_MS) continue
      this.dirty.delete(chat)
      this.checkedAt.set(chat, this.now())
      const rows =
        (await this.deps.store.listWhere?.('chat_item', { chat, kinds: CHECK_KINDS })) ??
        (await this.deps.store.list('chat_item')).filter((row) => chatOf(row) === chat && CHECK_KINDS.includes(row.kind))
      if (rows.some((row) => row.kind === 'helper' && parse(row.meta)['state'] === 'working')) continue
      const last = [...rows].reverse().find((row) => row.kind === 'agent' || row.kind === 'notice')
      // A turn that was stopped ends on the runner's "Stopped" notice: the row reads stopped, not done.
      const stopped = last?.kind === 'notice' && /^Stopped$/.test(last.text.trim())
      const failed = last?.kind === 'notice' && !stopped
      await this.patch(chat, {
        state: stopped ? 'stopped' : failed ? 'failed' : 'done',
        summary: clip(last?.text ?? 'Done'),
        result: (last?.text ?? '').slice(0, 6000),
        endedAt: this.now(),
      }, false)
      this.tracked.delete(chat)
      this.dirty.delete(chat)
      this.checkedAt.delete(chat)
    }
    if (this.tracked.size === 0 && this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async patch(chat: string, patch: Record<string, unknown>, onlyWhileWorking: boolean): Promise<void> {
    const row = await this.deps.store.get('chat_item', rowIdFor(chat))
    if (row === null) return
    const meta = parse(row.meta)
    if (onlyWhileWorking && meta['state'] !== 'working') return
    await this.deps.store.upsert('chat_item', { id: row.id, kind: row.kind, text: row.text, meta: JSON.stringify({ ...meta, ...patch }) })
    this.deps.changed?.()
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.writing.then(work).catch(() => undefined)
    this.writing = next
    return next
  }
}

function parse(meta: string): Record<string, unknown> {
  try {
    const value = JSON.parse(meta) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function chatOf(row: ChatItem): string {
  const chat = parse(row.meta)['chat']
  return typeof chat === 'string' && chat !== '' ? chat : MAIN_CHAT
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > MAX_SUMMARY ? `${one.slice(0, MAX_SUMMARY - 1)}…` : one
}
