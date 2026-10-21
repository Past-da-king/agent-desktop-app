/**
 * Long-term memory in the main process: New Chat, filing chats in the background, past-chat search and the
 * end-of-day pass. New Chat returns as soon as the divider is written; the model call that files the old chat runs
 * on a queue behind it and writes its outcome onto that divider, where the chat shows "Saved 3 memories".
 */
import type { ChatItem, ChatMemoryNote, PastChatHit } from '@agent/core'

import type { DataStore } from '../runtime/data'
import type { ChatIndex } from './chat-index'
import { chatSegments, hasSubstance, isDividerRow, memoryNote, parseMeta, transcript } from './chats'
import { DEFAULT_DAILY_AT, dayKey, dueDay, runDaily, undoChange } from './daily'
import { asWriter } from './history'
import { FILE_SYSTEM, candidatesFor, fileEntries, filePrompt, parseDigest, type ChatDigest, type Complete } from './summarise'
import type { UpkeepFile, UpkeepReport, UpkeepState } from './upkeep-log'

export interface MemoryServiceDeps {
  store: DataStore
  /** The model call on the person's current runtime (API key or plan). */
  complete: Complete
  index: ChatIndex
  upkeep: UpkeepFile
  /** Forgets a chat's conversation on the person's plan (its turn thread), so the next turn starts a fresh session. */
  forgetSession?: (thread: string) => void
  /** Tells the window the chat rows changed. */
  emitChat?: () => void
  /** Tells the window the upkeep report changed. */
  emitUpkeep?: (report: UpkeepReport | null) => void
  /** "HH:mm" for the daily pass, or '' to turn it off (the End of day routine's time and on/off). */
  dailyAt?: () => string | Promise<string>
  /** Called after every daily pass, whatever started it, so the End of day routine shows its last run. */
  onDaily?: (report: UpkeepReport) => void | Promise<void>
  now?: () => number
  log?: (message: string, detail?: Record<string, string | number>) => void
}

const CHECK_MS = 60_000

export class MemoryService {
  private readonly deps: MemoryServiceDeps
  private readonly now: () => number
  private chain: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  private dailyRunning: Promise<UpkeepReport> | null = null

  constructor(deps: MemoryServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  // ---- New Chat ----

  /**
   * A fresh chat at once. The chat before it stays in the history and leaves the model's context (the runner reads
   * turns after the newest divider only). If it had substance it is filed into memory in the background.
   */
  async newChat(target?: { chat: string; from: string }): Promise<{ dividerId: string | null; saving: boolean }> {
    if (target !== undefined) {
      // The main thread (and any chat started fresh in place) keeps going in the same chat with a summary of itself.
      if (target.chat === target.from) return this.compressChat(target.chat)
      return this.newSeparateChat(target.chat, target.from)
    }
    // Below: the single-stream New chat (a divider in the first chat). The app no longer calls it (memory/ipc.ts
    // always names a fresh chat); it stays for rows written before chats had ids.
    const items = await this.deps.store.list('chat_item')
    const latest = items.filter((item) => item.kind !== 'branch').sort((a, b) => b.createdAt - a.createdAt)[0]
    if (latest !== undefined && isDividerRow(latest)) return { dividerId: latest.id, saving: false }

    const segments = chatSegments(items)
    const closing = segments[segments.length - 1]
    const saving = closing !== undefined && hasSubstance(closing)
    const meta: Record<string, unknown> = { divider: true, at: this.now() }
    if (saving && closing !== undefined) meta['memory'] = { chat: closing.id, status: 'saving' } satisfies ChatMemoryNote
    const divider = await this.deps.store.upsert('chat_item', { kind: 'notice', text: 'New chat', meta: JSON.stringify(meta) })
    try {
      this.deps.forgetSession?.('main')
    } catch {
      // Losing the session id only means the next turn starts a fresh conversation, which is what we want.
    }
    this.deps.emitChat?.()
    if (saving) this.enqueue(divider.id)
    return { dividerId: divider.id, saving }
  }

  /**
   * Several chats at once: New chat opened `chat`, a fresh chat of its own, and left `from`, which keeps running and
   * keeps its context. The new chat starts with a divider that files what `from` said so far into memory in the
   * background, and shows the note ("Saved 3 memories from the last chat") where the person is now looking.
   */
  private async newSeparateChat(chat: string, from: string): Promise<{ dividerId: string | null; saving: boolean }> {
    const items = await this.deps.store.list('chat_item')
    const already = items.find((item) => isDividerRow(item) && chatOf(item) === chat)
    if (already !== undefined) return { dividerId: already.id, saving: false }
    const closing = chatSegments(items)
      .filter((segment) => segment.chat === from)
      .at(-1)
    // A stretch already filed once is not filed again.
    const filed = closing !== undefined && items.some((item) => isDividerRow(item) && memoryNote(item)?.chat === closing.id)
    const saving = closing !== undefined && !filed && hasSubstance(closing)
    const meta: Record<string, unknown> = { divider: true, at: this.now(), ...(chat === 'main' ? {} : { chat }) }
    if (saving && closing !== undefined) meta['memory'] = { chat: closing.id, status: 'saving' } satisfies ChatMemoryNote
    const divider = await this.deps.store.upsert('chat_item', { kind: 'notice', text: 'New chat', meta: JSON.stringify(meta) })
    this.deps.emitChat?.()
    if (saving) this.enqueue(divider.id)
    return { dividerId: divider.id, saving }
  }

  /**
   * New chat in the main thread: not a new chat and not a cut. The conversation so far is compressed into a short
   * summary in the background and the agent carries on fresh with that summary in context (runner withContextNotes
   * reads it off this divider). What it said is also filed into memory, as with any chat.
   */
  private async compressChat(chat: string): Promise<{ dividerId: string | null; saving: boolean }> {
    const items = await this.deps.store.list('chat_item')
    const own = items.filter((item) => chatOf(item) === chat && item.kind !== 'branch')
    const latest = own.sort((a, b) => b.createdAt - a.createdAt)[0]
    if (latest === undefined || isDividerRow(latest)) return { dividerId: latest?.id ?? null, saving: false }
    const closing = chatSegments(items)
      .filter((segment) => segment.chat === chat)
      .at(-1)
    const filed = closing !== undefined && items.some((item) => isDividerRow(item) && memoryNote(item)?.chat === closing.id)
    const saving = closing !== undefined && !filed && hasSubstance(closing)
    const spoken = closing !== undefined && closing.items.some((item) => (item.kind === 'user' || item.kind === 'agent') && item.text.trim() !== '')
    const meta: Record<string, unknown> = { divider: true, at: this.now(), ...(chat === 'main' ? {} : { chat }), ...(spoken ? { compress: 'pending' } : {}) }
    if (saving && closing !== undefined) meta['memory'] = { chat: closing.id, status: 'saving' } satisfies ChatMemoryNote
    const divider = await this.deps.store.upsert('chat_item', { kind: 'notice', text: 'New chat', meta: JSON.stringify(meta) })
    try {
      this.deps.forgetSession?.(chat === 'main' ? 'main' : `chat:${chat}`)
    } catch {
      // Losing the session id only means the next turn starts a fresh conversation, which is what we want.
    }
    this.deps.emitChat?.()
    if (spoken && closing !== undefined) this.compressQueue(divider.id, closing.id)
    if (saving) this.enqueue(divider.id)
    return { dividerId: divider.id, saving }
  }

  /** Compressing runs ahead of filing: the person may type again at once and the agent needs the gist. */
  private compressQueue(dividerId: string, segmentId: string): void {
    void this.compress(dividerId, segmentId).catch(() => undefined)
  }

  private async compress(dividerId: string, segmentId: string): Promise<void> {
    const items = await this.deps.store.list('chat_item')
    const segment = chatSegments(items).find((item) => item.id === segmentId)
    let carry = ''
    let status: 'done' | 'failed' = 'failed'
    if (segment !== undefined) {
      // A stretch that began with a summary of its own carries that one forward too.
      const before = segment.startDivider === null ? '' : String(parseMeta(segment.startDivider.meta)['carry'] ?? '')
      try {
        carry = (await this.deps.complete(COMPRESS_SYSTEM, compressPrompt(before, transcript(segment, 40_000)))).trim().slice(0, 4_000)
        status = carry === '' ? 'failed' : 'done'
      } catch (error) {
        this.deps.log?.('Chat could not be compressed', { error: plainError(error) })
      }
    }
    const divider = await this.deps.store.get('chat_item', dividerId)
    if (divider === null) return
    const meta = { ...parseMeta(divider.meta), compress: status, ...(carry === '' ? {} : { carry }) }
    await this.deps.store.upsert('chat_item', { id: divider.id, kind: divider.kind, text: divider.text, meta: JSON.stringify(meta) })
    this.deps.emitChat?.()
  }

  /** Files a chat again after it failed. */
  async retrySave(dividerId: string): Promise<void> {
    const divider = await this.deps.store.get('chat_item', dividerId)
    if (divider === null || !isDividerRow(divider)) return
    const note = memoryNote(divider)
    if (note === null || note.status === 'saving') return
    await this.writeNote(divider, { chat: note.chat, status: 'saving' })
    this.enqueue(dividerId)
  }

  /** After a restart: chats that were still being filed are filed again. */
  async restore(): Promise<void> {
    const items = await this.deps.store.list('chat_item')
    for (const item of items) {
      if (!isDividerRow(item)) continue
      if (memoryNote(item)?.status === 'saving') this.enqueue(item.id)
    }
  }

  /** Resolves when every queued filing has finished (tests, and shutdown). */
  idle(): Promise<void> {
    return this.chain
  }

  private enqueue(dividerId: string): void {
    this.chain = this.chain.then(() => this.file(dividerId)).catch(() => undefined)
  }

  private async file(dividerId: string): Promise<void> {
    const divider = await this.deps.store.get('chat_item', dividerId)
    if (divider === null) return
    const note = memoryNote(divider)
    if (note === null) return
    const items = await this.deps.store.list('chat_item')
    const segment = chatSegments(items).find((item) => item.id === note.chat)
    if (segment === undefined) {
      await this.writeNote(divider, { chat: note.chat, status: 'failed', error: 'That chat is no longer here.' })
      return
    }
    const started = this.now()
    try {
      const chat = transcript(segment)
      const memories = await this.deps.store.list('memory')
      const prompt = filePrompt(chat, candidatesFor(chat, memories), dayKey(this.now()))
      const digest = await this.digestOf(prompt)
      const result = await asWriter('chat filing', digest.title, () => fileEntries(this.deps.store, digest.entries))
      const fresh = (await this.deps.store.get('chat_item', dividerId)) ?? divider
      await this.writeNote(
        fresh,
        {
          chat: note.chat,
          status: 'done',
          saved: [...result.added, ...result.updated],
          added: result.added.length,
          updated: result.updated.length,
        },
        { summary: digest.summary, title: digest.title },
      )
      this.deps.log?.('Chat filed into memory', {
        added: result.added.length,
        updated: result.updated.length,
        dropped: result.dropped,
        redacted: result.redacted,
        ms: this.now() - started,
      })
    } catch (error) {
      const fresh = (await this.deps.store.get('chat_item', dividerId)) ?? divider
      await this.writeNote(fresh, { chat: note.chat, status: 'failed', error: plainError(error) })
      this.deps.log?.('Chat could not be filed', { error: plainError(error) })
    }
  }

  /** The model's summary of a chat. A reply that cannot be read is asked for once more, plainly. */
  private async digestOf(prompt: string): Promise<ChatDigest> {
    const first = await this.deps.complete(FILE_SYSTEM, prompt)
    try {
      return parseDigest(first)
    } catch (error) {
      this.deps.log?.('Chat summary unreadable, asking again', { chars: first.length, error: plainError(error) })
      const again = `${prompt}\n\nYour last reply could not be read as JSON. Reply again with ONLY the JSON object: no prose, no code fence, every line break inside a string written as \\n, and short bodies so it fits.`
      return parseDigest(await this.deps.complete(FILE_SYSTEM, again))
    }
  }

  private async writeNote(divider: ChatItem, note: ChatMemoryNote, extra: Record<string, string> = {}): Promise<void> {
    const meta = parseMeta(divider.meta)
    const next: Record<string, unknown> = { ...meta, memory: note }
    for (const [key, value] of Object.entries(extra)) if (value.trim() !== '') next[key] = value.trim()
    await this.deps.store.upsert('chat_item', { id: divider.id, kind: divider.kind, text: divider.text, meta: JSON.stringify(next) })
    this.deps.emitChat?.()
  }

  // ---- past chats ----

  async searchChats(query: string, limit = 5, excludeCurrent = true): Promise<PastChatHit[]> {
    const items = await this.deps.store.list('chat_item')
    this.deps.index.refresh(items)
    const segments = chatSegments(items)
    const current = segments[segments.length - 1]
    return this.deps.index.search(query, {
      limit,
      ...(excludeCurrent && current !== undefined ? { exclude: current.id } : {}),
    })
  }

  // ---- the end-of-day pass ----

  /** Checks once a minute whether the daily pass is due, and once right away (a slot missed while closed). */
  start(): void {
    if (this.timer !== null) return
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, CHECK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<UpkeepReport | null> {
    if (this.dailyRunning !== null) return null
    const slot = (await this.deps.dailyAt?.()) ?? DEFAULT_DAILY_AT
    if (slot.trim() === '' || this.dailyRunning !== null) return null
    const state = this.deps.upkeep.read()
    const items = await this.deps.store.list('chat_item')
    const lastChatAt = items.reduce((latest, item) => (item.kind === 'user' && item.createdAt > latest ? item.createdAt : latest), 0)
    const due = dueDay(this.now(), slot, state.lastDay, lastChatAt)
    if (due === null) return null
    return this.daily(due.catchUp ? 'catch-up' : 'schedule', due)
  }

  /** "Run now": today's chats so far, then the sweep. */
  runNow(): Promise<UpkeepReport> {
    const now = this.now()
    const from = new Date(now)
    from.setHours(0, 0, 0, 0)
    return this.daily('manual', { day: dayKey(now), from: from.getTime(), to: now + 1 })
  }

  upkeepState(): UpkeepState {
    return this.deps.upkeep.read()
  }

  async undo(changeId: string): Promise<boolean> {
    const done = await asWriter('you', 'undid an end of day change', () => undoChange(this.deps.store, this.deps.upkeep, changeId))
    if (done) this.deps.emitUpkeep?.(this.deps.upkeep.read().report)
    return done
  }

  private daily(trigger: UpkeepReport['trigger'], window: { day: string; from: number; to: number }): Promise<UpkeepReport> {
    if (this.dailyRunning !== null) return this.dailyRunning
    const run = asWriter('end of day', undefined, () => runDaily({ store: this.deps.store, complete: this.deps.complete, upkeep: this.deps.upkeep, now: this.now }, trigger, window))
      .then((report) => {
        this.deps.log?.('Daily memory pass', { trigger, changes: report.changes.length, ok: report.ok ? 1 : 0 })
        this.deps.emitUpkeep?.(report)
        return Promise.resolve(this.deps.onDaily?.(report))
          .catch(() => undefined)
          .then(() => report)
      })
      .finally(() => {
        this.dailyRunning = null
      })
    this.dailyRunning = run
    return run
  }
}

/** The brief for compressing a conversation the agent carries on from (main thread New chat). */
export const COMPRESS_SYSTEM = [
  "You compress a conversation between the user and their personal agent so the agent can carry on without the full transcript.",
  'Write at most 250 words of plain markdown bullets under these headings, leaving out a heading with nothing under it:',
  '**Working on** (the current task or tasks), **Decided** (with the reason), **In progress** (who or what is doing it, where it stands), **Asked last** (the newest request and whether it is answered).',
  'Facts only: exact names, dates, amounts and places. No secrets, passwords or codes. No preamble.',
].join('\n')

export function compressPrompt(before: string, chat: string): string {
  return `${before.trim() === '' ? '' : `SUMMARY OF EARLIER PARTS:\n${before.trim()}\n\n`}THE CONVERSATION:\n${chat}`
}

function plainError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.trim() === '' ? 'Something went wrong.' : text.split('\n')[0]?.slice(0, 200) ?? text
}

/** The chat a row belongs to: `meta.chat`, else the first chat ('main'). */
function chatOf(item: ChatItem): string {
  const value = parseMeta(item.meta)['chat']
  return typeof value === 'string' && value !== '' ? value : 'main'
}
