/**
 * Agent acts for me on approvals (23 Nov 2026).
 *
 * Ayanda: "I am tired of approving things. You are supposed to act as me in this application. Only raise things that
 * matter. The major thing is when you are sending out text to someone: that is when you come to me. For the rest,
 * you vet and decide whether it's worth me seeing it, or approve on my behalf."
 *
 * This is the one place that
 *   1. stamps every card the app raises with its real origin and verdict (stamp),
 *   2. hands the cards in the agent's lane to the main agent, as a note, when the setting is on (route),
 *   3. lets the main agent answer them, and refuses everything that is his (answer) - the verdict is recomputed
 *      here from what the app stamped, never taken from the card's words or from the lane stored on it,
 *   4. keeps the "Answered for you" record and its Undo (list, undo),
 *   5. brings a card back to him when the main agent escalates, is too slow, or the setting goes off (escalate),
 *   6. closes cards that stopped standing (sweep, shared/stale-card.ts).
 *
 * With the setting off nothing is routed, nothing is escalated by the sweep except what was routed, and every card
 * asks him exactly as before.
 */
import { MAIN_CHAT, type ChatItem, type Settings } from '@agent/core'

import { classifyCard, type Asker, type CardOrigin } from '../../shared/approval-policy'
import {
  autoAnswerOf,
  closedOf,
  isCardRow,
  isDecidedCard,
  isLiveCard,
  isRoutedPending,
  metaOfCard,
  ROUTE_TIMEOUT_MS,
  stampCard,
  verdictOfRow,
  type AutoAnswer,
  type UndoKind,
} from '../../shared/card-state'
import { staleReason, type StaleFacts, type StaleReason } from '../../shared/stale-card'
import { CardDecidedError } from './card-claim'
import { chatOf } from './chat-lines'
import { listWhere, type DataStore } from './data'

export const BY_MAIN = 'main agent'
/** Cards looked at per sweep, so a store with a long history is never read in full each minute. */
const SWEEP_MAX = 80
const NOTE_BATCH_MS = 4000
const HOLD_MS = 30 * 60_000

export interface ActsDeps {
  store: DataStore
  settings: { get: () => Pick<Settings, 'actsForMe'> & Partial<Settings> }
  now?: () => number
  /** Decide an approval card (Runner.decide: first decision wins, wakes the waiter). */
  decide: (id: string, decision: 'approve' | 'decline', by: string) => Promise<void>
  /** Answer a question card (Runner.answer). */
  answerQuestion: (id: string, answer: string, by: string) => Promise<void>
  /** Write a note into the main chat so the main agent acts on it. */
  postToMain: (text: string) => Promise<void>
  /** Tell the agent that asked (a helper or a project chat), for an Undo. */
  tellAsker?: (row: ChatItem, text: string) => Promise<void>
  /** Put settings back (Undo of a settings change). */
  setSettings?: (patch: Record<string, unknown>) => Promise<void>
  hasWaiter: (id: string) => boolean
  /** Helpers that are running, queued or running on another computer that is up. */
  liveHelpers: () => ReadonlySet<string>
  chatRunning: (chat: string) => boolean
  /** The helper's card is placed on another computer that is up: that computer judges it. */
  placedElsewhere?: (helperMeta: Record<string, unknown>) => boolean
  /** A card went back to him: ring the panel and notify. */
  needsYou: (id: string, chat: string, summary: string) => void
  /** The card list changed. */
  changed: (chat?: string) => void
  /** A name for who asked, when the row has none. */
  labelOf?: (row: ChatItem) => string
}

export interface StampArgs {
  kind: 'approval' | 'question'
  asker: Asker
  /** The helper id or chat the card belongs to: Undo holds this asker's next cards for him. */
  askerKey: string
  origin?: CardOrigin | undefined
  summary: string
  details?: string | undefined
  options?: string[] | undefined
}

export type AnswerArgs =
  | { id: string; action: 'approve' | 'decline'; reason: string }
  | { id: string; action: 'answer'; answer: string; reason: string }
  | { id: string; action: 'escalate'; reason: string }

export type ActResult = { ok: true; message: string } | { ok: false; message: string }

export interface AnsweredEntry {
  id: string
  at: number
  asker: string
  summary: string
  decision: 'approve' | 'decline' | 'answer'
  answer: string
  reason: string
  rule: string
  undo: UndoKind
  undone: number
}

export interface WaitingEntry {
  id: string
  kind: 'approval' | 'question'
  asker: string
  summary: string
  details: string
  options: string[]
  rule: string
  ageMs: number
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

export class ActsForMe {
  private readonly holds = new Map<string, number>()
  private noteTimer: ReturnType<typeof setTimeout> | null = null
  private readonly queued = new Set<string>()
  private sweeping = false

  constructor(private readonly deps: ActsDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** The setting. Existing installs have it on: it is on in the defaults and only he turns it off. */
  enabled(): boolean {
    return this.deps.settings.get().actsForMe !== false
  }

  // ---- stamping ---------------------------------------------------------------------------------------------

  /** The meta a card gets when it is raised. A card in the agent's lane is routed to the main agent when the setting is on. */
  stamp(args: StampArgs): Record<string, unknown> {
    const hold = this.holding(args.askerKey)
    return stampCard({
      kind: args.kind,
      asker: args.asker,
      ...(args.origin === undefined ? {} : { origin: args.origin }),
      summary: args.summary,
      ...(args.details === undefined ? {} : { details: args.details }),
      ...(args.options === undefined ? {} : { options: args.options }),
      actsForMe: this.enabled(),
      holdForHim: hold,
      now: this.now(),
    })
  }

  private holding(key: string): boolean {
    const until = this.holds.get(key)
    if (until === undefined) return false
    if (until < this.now()) {
      this.holds.delete(key)
      return false
    }
    return true
  }

  /** A card was just raised and routed: the main agent hears about it (a few at once make one note). */
  route(id: string): void {
    if (!this.enabled()) return
    this.queued.add(id)
    if (this.noteTimer !== null) return
    this.noteTimer = setTimeout(() => {
      this.noteTimer = null
      void this.flushNote().catch(() => undefined)
    }, NOTE_BATCH_MS)
    this.noteTimer.unref?.()
  }

  dispose(): void {
    if (this.noteTimer !== null) clearTimeout(this.noteTimer)
    this.noteTimer = null
  }

  private async flushNote(): Promise<void> {
    const ids = [...this.queued]
    this.queued.clear()
    const lines: string[] = []
    for (const id of ids) {
      const row = await this.deps.store.get('chat_item', id)
      if (row === null || !isLiveCard(row) || !isRoutedPending(row)) continue
      const meta = metaOfCard(row)
      if (typeof meta['notedAt'] === 'number') continue
      await this.patch(id, { notedAt: this.now() })
      lines.push(`- ${id}: ${this.labelOf(row)} asks (${row.kind}): ${clip(String(meta['summary'] ?? row.text), 240)}`)
    }
    if (lines.length === 0) return
    await this.deps.postToMain(
      [
        `[Approvals for Ayanda] ${lines.length} card${lines.length === 1 ? ' is' : 's are'} waiting for you to answer on his behalf ("Agent acts for me" is on). Call cards_waiting for the full text, then card_answer for each: approve, decline, answer a question from what you know, or escalate to him when it is truly worth his eyes. Reasons are one line. Anything that sends text to a person, spends money or needs his own hands is refused by card_answer and is already his.`,
        ...lines,
      ].join('\n'),
    )
  }

  // ---- what the main agent sees ------------------------------------------------------------------------------

  async waiting(): Promise<WaitingEntry[]> {
    const rows = await listWhere(this.deps.store, 'chat_item', { kinds: ['approval', 'question'] })
    const now = this.now()
    return rows
      .filter((row) => isLiveCard(row) && isRoutedPending(row))
      .map((row): WaitingEntry => {
        const meta = metaOfCard(row)
        return {
          id: row.id,
          kind: row.kind === 'approval' ? 'approval' : 'question',
          asker: this.labelOf(row),
          summary: String(meta['summary'] ?? row.text),
          details: clip(String(meta['details'] ?? ''), 2000),
          options: Array.isArray(meta['options']) ? meta['options'].filter((each): each is string => typeof each === 'string') : [],
          rule: String(meta['laneRule'] ?? ''),
          ageMs: now - row.createdAt,
        }
      })
      .sort((a, b) => b.ageMs - a.ageMs)
  }

  private labelOf(row: ChatItem): string {
    const meta = metaOfCard(row)
    const by = typeof meta['by'] === 'string' ? meta['by'] : ''
    if (by !== '') return by
    const custom = this.deps.labelOf?.(row) ?? ''
    if (custom !== '') return custom
    const asker = String(meta['asker'] ?? '')
    return asker === 'project' ? 'A project chat' : asker === 'routine' ? 'A routine' : asker === 'helper' ? 'A helper' : 'An agent'
  }

  // ---- answering ---------------------------------------------------------------------------------------------

  /**
   * The main agent answers a card for him. Refused with the reason when the card is his (sent text, money, his own
   * hands, a secret, unknown, the main agent's own), when it already stands decided or closed, or when the setting is off.
   */
  async answer(args: AnswerArgs): Promise<ActResult> {
    if (!this.enabled()) return { ok: false, message: 'Refused: "Agent acts for me on approvals" is off, so every card is his.' }
    const reason = args.reason.trim().replace(/\s+/g, ' ').slice(0, 300)
    if (reason === '') return { ok: false, message: 'Say why in one line (reason).' }
    const row = await this.deps.store.get('chat_item', args.id)
    if (row === null || !isCardRow(row)) return { ok: false, message: 'Refused: there is no such card.' }
    if (isDecidedCard(row)) return { ok: false, message: 'Not done: that card is already decided.' }
    const closed = closedOf(row)
    if (closed !== null) return { ok: false, message: `Not done: that card already closed itself (${closed.why || closed.reason}).` }

    // The hard safety: recomputed from the real tool call the app stamped. The words on the card, and the lane stored
    // when it was raised, cannot move a card into the agent's lane; a stored "him" or a recomputed "him" both refuse.
    const meta = metaOfCard(row)
    const verdict = verdictOfRow(row)
    if (verdict.lane !== 'agent' || meta['lane'] === 'him') {
      const why = verdict.lane !== 'agent' ? verdict.why : String(meta['laneWhy'] ?? 'It is his.')
      return { ok: false, message: `Refused: ${why} This card is Ayanda's to answer; it stays on his Needs you panel.` }
    }

    if (args.action === 'escalate') {
      await this.escalate(args.id, reason)
      return { ok: true, message: 'Escalated: it is now on his Needs you panel with your reason.' }
    }
    const asker = this.labelOf(row)
    const summary = clip(String(meta['summary'] ?? row.text), 240)
    if (row.kind === 'approval' && args.action === 'answer') return { ok: false, message: 'This is an approval: use approve or decline.' }
    if (row.kind === 'question' && args.action !== 'answer') return { ok: false, message: 'This is a question: use action answer with the answer text.' }
    if (args.action === 'answer' && args.answer.trim() === '') return { ok: false, message: 'Give the answer text.' }

    // For a settings change, remember what it was, so an Undo can put it back.
    const revert = this.revertFor(row)
    try {
      if (args.action === 'answer') await this.deps.answerQuestion(args.id, args.answer.trim(), BY_MAIN)
      else await this.deps.decide(args.id, args.action, BY_MAIN)
    } catch (error) {
      if (error instanceof CardDecidedError) return { ok: false, message: `Not done: ${error.message}.` }
      return { ok: false, message: `Not done: ${error instanceof Error ? error.message : 'it did not go through'}.` }
    }
    const undo: UndoKind =
      row.kind === 'question' ? 'reask' : args.action === 'decline' ? 'retry' : revert !== undefined ? 'revert-setting' : 'none'
    const record: AutoAnswer = {
      at: this.now(),
      by: BY_MAIN,
      decision: args.action,
      ...(args.action === 'answer' ? { answer: args.answer.trim() } : {}),
      reason,
      asker,
      summary,
      undo,
      ...(revert === undefined ? {} : { revert }),
    }
    await this.patch(args.id, { autoAnswer: record })
    this.deps.changed(chatOf(row))
    return { ok: true, message: args.action === 'answer' ? 'Answered for him. It is in Answered for you.' : `${args.action === 'approve' ? 'Approved' : 'Declined'} for him. It is in Answered for you.` }
  }

  /** The values a settings card is about to change, read before it is decided. */
  private revertFor(row: ChatItem): Record<string, unknown> | undefined {
    const origin = metaOfCard(row)['origin']
    if (typeof origin !== 'object' || origin === null) return undefined
    const tool = (origin as Record<string, unknown>)['tool']
    const input = (origin as Record<string, unknown>)['input']
    if (tool !== 'settings_set' || typeof input !== 'object' || input === null) return undefined
    const values = (input as Record<string, unknown>)['values']
    if (typeof values !== 'object' || values === null) return undefined
    const current = this.deps.settings.get() as unknown as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(values)) if (key in current) out[key] = current[key]
    return Object.keys(out).length === 0 ? undefined : out
  }

  // ---- escalating --------------------------------------------------------------------------------------------

  /** Back to him: it shows on Needs you, with why. */
  async escalate(id: string, why: string): Promise<void> {
    const row = await this.deps.store.get('chat_item', id)
    if (row === null || !isLiveCard(row)) return
    const meta = metaOfCard(row)
    if (typeof meta['escalatedAt'] === 'number') return
    await this.patch(id, { escalatedAt: this.now(), escalatedWhy: clip(why, 300) })
    this.deps.changed(chatOf(row))
    this.deps.needsYou(id, chatOf(row), String(meta['summary'] ?? row.text))
  }

  // ---- the list and Undo -------------------------------------------------------------------------------------

  async list(limit = 100): Promise<AnsweredEntry[]> {
    const rows = await listWhere(this.deps.store, 'chat_item', { kinds: ['approval', 'question'], contains: '"autoAnswer"', newestFirst: true, limit: Math.max(1, Math.min(limit, 500)) })
    const out: AnsweredEntry[] = []
    for (const row of rows) {
      const record = autoAnswerOf(row)
      if (record === null) continue
      out.push({
        id: row.id,
        at: record.at,
        asker: record.asker,
        summary: record.summary,
        decision: record.decision,
        answer: record.answer ?? '',
        reason: record.reason,
        rule: String(metaOfCard(row)['laneRule'] ?? ''),
        undo: record.undone === undefined ? record.undo : 'none',
        undone: record.undone ?? 0,
      })
    }
    return out.sort((a, b) => b.at - a.at)
  }

  /**
   * Undo one answered card where it can be undone: put a changed setting back, or withdraw a decline or an answer
   * (the asker is told, and its next card goes to him whatever it is, for half an hour).
   */
  async undo(id: string): Promise<ActResult> {
    const row = await this.deps.store.get('chat_item', id)
    const record = row === null ? null : autoAnswerOf(row)
    if (row === null || record === null) return { ok: false, message: 'There is nothing to undo on that card.' }
    if (record.undone !== undefined) return { ok: false, message: 'That was already undone.' }
    if (record.undo === 'none') return { ok: false, message: 'That cannot be undone: the action already ran.' }
    if (record.undo === 'revert-setting') {
      if (record.revert === undefined || this.deps.setSettings === undefined) return { ok: false, message: 'The old values are not kept, so it cannot be put back.' }
      await this.deps.setSettings(record.revert)
    } else {
      const meta = metaOfCard(row)
      const key = String(meta['helper'] ?? '') || chatOf(row)
      this.holds.set(key, this.now() + HOLD_MS)
      const text =
        record.undo === 'retry'
          ? `Ayanda undid the decline of "${record.summary}". Try the action again: this time the card goes to him himself.`
          : `Ayanda withdrew the answer "${record.answer ?? ''}" to your question "${record.summary}". Ask him again: this time the question goes to him himself.`
      await this.deps.tellAsker?.(row, text).catch(() => undefined)
    }
    await this.patch(id, { autoAnswer: { ...record, undone: this.now() } })
    this.deps.changed(chatOf(row))
    return { ok: true, message: record.undo === 'revert-setting' ? 'Put the setting back.' : 'Withdrawn. The asker is told, and its next card comes to you.' }
  }

  // ---- the sweep: routed cards, and cards that stopped standing ----------------------------------------------

  async sweep(): Promise<{ closed: number; escalated: number; noted: number }> {
    if (this.sweeping) return { closed: 0, escalated: 0, noted: 0 }
    this.sweeping = true
    const result = { closed: 0, escalated: 0, noted: 0 }
    try {
      const rows = (await listWhere(this.deps.store, 'chat_item', { kinds: ['approval', 'question'], newestFirst: true, limit: 600 })).filter((row) => isLiveCard(row)).slice(0, SWEEP_MAX)
      const now = this.now()
      const enabled = this.enabled()
      for (const row of rows) {
        if (isRoutedPending(row)) {
          const routedAt = Number(metaOfCard(row)['routedAt'])
          if (!enabled) {
            await this.escalate(row.id, 'Agent acts for me is off, so this one is yours.')
            result.escalated += 1
            continue
          }
          if (now - routedAt > ROUTE_TIMEOUT_MS) {
            await this.escalate(row.id, 'The main agent did not answer it in 10 minutes, so it is yours.')
            result.escalated += 1
            continue
          }
          if (typeof metaOfCard(row)['notedAt'] !== 'number') {
            this.route(row.id)
            result.noted += 1
          }
        }
        const verdict = await this.staleOf(row, now)
        if (verdict !== null) {
          await this.close(row, verdict.reason, verdict.why)
          result.closed += 1
        }
      }
    } finally {
      this.sweeping = false
    }
    return result
  }

  private async staleOf(row: ChatItem, now: number): Promise<{ reason: StaleReason; why: string } | null> {
    const meta = metaOfCard(row)
    const helperId = typeof meta['helper'] === 'string' ? meta['helper'] : ''
    const chat = chatOf(row)
    let helperState: string | null | undefined
    let helperMeta: Record<string, unknown> = {}
    if (helperId !== '') {
      const helperRow = await this.deps.store.get('chat_item', helperId).catch(() => null)
      helperMeta = helperRow === null ? {} : metaOfCard(helperRow)
      helperState = helperRow === null ? null : String(helperMeta['state'] ?? 'working')
    }
    const newer = await listWhere(this.deps.store, 'chat_item', { chat, since: row.createdAt, exceptKinds: ['helper', 'report', 'notice', 'branch'], limit: 250 }).catch(() => [] as ChatItem[])
    let user = false
    let agent = false
    let newerCard = false
    for (const item of newer) {
      if (item.id === row.id) continue
      const itemMeta = metaOfCard(item)
      if (item.kind === 'approval' || item.kind === 'question') {
        const sameAsker = helperId !== '' ? itemMeta['helper'] === helperId : typeof itemMeta['helper'] !== 'string' || itemMeta['helper'] === ''
        if (sameAsker && item.kind === row.kind && item.createdAt > row.createdAt) newerCard = true
        continue
      }
      if (helperId !== '') continue
      const own = typeof itemMeta['helper'] !== 'string' || itemMeta['helper'] === ''
      if (item.kind === 'user' && typeof itemMeta['via'] !== 'object') user = true
      else if ((item.kind === 'agent' || item.kind === 'activity') && own) agent = true
    }
    let helperProgressed = false
    if (helperId !== '') {
      const steps = await listWhere(this.deps.store, 'chat_item', { kind: 'activity', since: row.createdAt, contains: `"helper":"${helperId}"`, limit: 1 }).catch(() => [] as ChatItem[])
      helperProgressed = steps.length > 0
    }
    const facts: StaleFacts = {
      hasWaiter: this.deps.hasWaiter(row.id),
      askerElsewhere: helperId !== '' && (this.deps.placedElsewhere?.(helperMeta) ?? false),
      ...(helperState === undefined ? {} : { helperState }),
      helperLive: helperId !== '' && this.deps.liveHelpers().has(helperId),
      chatNewer: { user, agent },
      helperProgressed,
      newerCard,
      chatRunning: this.deps.chatRunning(chat),
      now,
      createdAt: row.createdAt,
    }
    return staleReason(facts)
  }

  /** The card stops standing: it leaves Needs you, nothing is deleted, the reason stays on the row. */
  async close(row: ChatItem, reason: StaleReason | string, why: string): Promise<void> {
    await this.patch(row.id, { closedAt: this.now(), closedReason: reason, closedWhy: why })
    this.deps.changed(chatOf(row))
  }

  /** Merge fields into a card's meta, from the row as it is now. */
  private async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const store = this.deps.store
    if (store.mutate !== undefined) {
      await store.mutate('chat_item', id, (payload) => {
        const raw = typeof payload['meta'] === 'string' ? payload['meta'] : '{}'
        let meta: Record<string, unknown> = {}
        try {
          meta = JSON.parse(raw) as Record<string, unknown>
        } catch {
          meta = {}
        }
        return { next: { ...payload, meta: JSON.stringify({ ...meta, ...fields }) }, result: true }
      })
      return
    }
    const row = await store.get('chat_item', id)
    if (row === null) return
    await store.upsert('chat_item', { id: row.id, kind: row.kind, text: row.text, meta: JSON.stringify({ ...metaOfCard(row), ...fields }) })
  }
}

/** True when the main chat id is what a project-less card belongs to (for callers that label by chat). */
export function isMainChat(chat: string): boolean {
  return chat === MAIN_CHAT
}

// Kept for tests and callers that classify without a store.
export { classifyCard }
