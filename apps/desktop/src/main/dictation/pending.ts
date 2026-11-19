/**
 * Instant send: a dictated message goes into the chat at once with its live caption, and the whole take is written down
 * in the background (19 Nov 2026, Ayanda: "never make him wait"). This is the durable half that lives on the computer
 * that owns the chat.
 *
 * - `accept` takes a take (recording id, chat, the live caption, the audio) and returns at once. The take is written to
 *   disk first (`<dir>/<id>.json` and `<dir>/<id>.pcm`), so closing the app right after Send loses nothing.
 * - One pass over the whole audio then replaces the caption (`replace`), and whoever reads the message for the agent
 *   calls `settled(id)` to wait for the clean text, at most the take's cap (30 s + 0.5 s per second said, 100 s at
 *   most). If the pass fails or the cap passes, `settled` answers with the caption and a note, and the take stays on
 *   disk as `failed` for `retry`.
 * - Idempotent by recording id: accepting the same id again, or resuming a finished take, never runs or replaces twice.
 * - `resume` (called at start) runs every take that was queued or running when the app closed.
 */
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import type { BatchResult } from './controller'

export type TakeState = 'queued' | 'running' | 'done' | 'failed'

export interface TakeRecord {
  id: string
  chat: string | null
  /** The live caption that was sent with the message. */
  live: string
  state: TakeState
  /** The clean text, once the pass finished. */
  text?: string
  error?: string
  acceptedAt: number
}

/** What the agent gets for a take: the text to use and, when it is not the clean one, why. */
export interface Settled {
  id: string
  text: string
  clean: boolean
  note: string | null
}

export const FAILED_NOTE = 'dictated; clean transcript failed, this is the live caption'
const ID_PATTERN = /^[\w:-]{1,64}$/

/** How long the agent's turn may wait for a take of `bytes` of 16 kHz PCM16: 30 s + 0.5 s per second said, at most 100 s. */
export function holdCapMs(bytes: number): number {
  return Math.min(100_000, Math.round(30_000 + (bytes / 32_000) * 500))
}

export interface PendingDeps {
  dir: string
  /** The one whole-audio pass (dictation `batch`: names spelled, languages told). */
  batch: (pcm: Buffer, signal: AbortSignal) => Promise<BatchResult>
  /** The message in the chat becomes the clean text, in place (keyed by the take's id). */
  replace: (take: TakeRecord, text: string) => Promise<void> | void
  log: (message: string, fields?: Record<string, string | number | boolean>) => void
  now?: () => number
}

export class PendingTakes {
  private readonly deps: PendingDeps
  private readonly running = new Map<string, Promise<void>>()
  private readonly waiters = new Map<string, Array<(settled: Settled) => void>>()
  private readonly records = new Map<string, TakeRecord>()

  constructor(deps: PendingDeps) {
    this.deps = deps
  }

  /** Take a take; resolves once it is safely on disk. The pass runs in the background. */
  async accept(input: { id: string; chat: string | null; live: string; pcm: Buffer }): Promise<{ accepted: boolean; duplicate: boolean }> {
    if (!ID_PATTERN.test(input.id)) throw new Error('id must be a recording id')
    const have = (await this.load(input.id)) ?? null
    if (have !== null) return { accepted: true, duplicate: true }
    const record: TakeRecord = { id: input.id, chat: input.chat, live: input.live, state: 'queued', acceptedAt: (this.deps.now ?? Date.now)() }
    await fsp.mkdir(this.deps.dir, { recursive: true })
    await fsp.writeFile(this.pcmFile(input.id), input.pcm)
    await this.save(record)
    this.start(record.id)
    return { accepted: true, duplicate: false }
  }

  /** At start: every take that was waiting or running when the app closed carries on. */
  async resume(): Promise<number> {
    let names: string[] = []
    try {
      names = await fsp.readdir(this.deps.dir)
    } catch {
      return 0
    }
    let count = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const record = await this.load(name.slice(0, -5))
      if (record === null || (record.state !== 'queued' && record.state !== 'running')) continue
      count += 1
      this.start(record.id)
    }
    return count
  }

  /** Try a failed take again (the message's Retry). */
  async retry(id: string): Promise<boolean> {
    const record = await this.load(id)
    if (record === null || record.state !== 'failed') return false
    record.state = 'queued'
    delete record.error
    await this.save(record)
    this.start(id)
    return true
  }

  async state(id: string): Promise<TakeRecord | null> {
    return this.load(id)
  }

  /**
   * What the agent reads for this take: waits for the clean text, at most `capMs` (default: the take's own cap). A take
   * that is already done answers at once; one that failed or timed out answers with the caption and a note.
   */
  async settled(id: string, capMs?: number): Promise<Settled | null> {
    const record = await this.load(id)
    if (record === null) return null
    if (record.state === 'done') return { id, text: record.text ?? record.live, clean: true, note: null }
    if (record.state === 'failed') return { id, text: record.live, clean: false, note: FAILED_NOTE }
    const cap = capMs ?? holdCapMs((await this.size(id)) ?? 0)
    return new Promise<Settled>((resolve) => {
      const list = this.waiters.get(id) ?? []
      const timer = setTimeout(() => finish({ id, text: record.live, clean: false, note: FAILED_NOTE }), cap)
      const finish = (settled: Settled): void => {
        clearTimeout(timer)
        const waiting = this.waiters.get(id) ?? []
        this.waiters.set(id, waiting.filter((fn) => fn !== finish))
        resolve(settled)
      }
      list.push(finish)
      this.waiters.set(id, list)
    })
  }

  private start(id: string): void {
    if (this.running.has(id)) return
    const job = this.run(id).finally(() => this.running.delete(id))
    this.running.set(id, job)
  }

  private async run(id: string): Promise<void> {
    const record = await this.load(id)
    if (record === null || record.state === 'done') return
    record.state = 'running'
    await this.save(record)
    let result: BatchResult
    try {
      const pcm = await fsp.readFile(this.pcmFile(id))
      const limit = holdCapMs(pcm.length)
      result = await this.deps.batch(pcm, AbortSignal.timeout(limit))
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : 'Could not transcribe that.' }
    }
    if (result.ok && result.text.trim() !== '') {
      record.state = 'done'
      record.text = result.text.trim()
      await this.save(record)
      // Replace first, then free the agent's turn: it must read the clean text, never the caption.
      try {
        await this.deps.replace(record, record.text)
      } catch (error) {
        this.deps.log('Dictation take could not replace its message', { id, reason: error instanceof Error ? error.message : String(error) })
      }
      this.release({ id, text: record.text, clean: true, note: null })
      return
    }
    record.state = 'failed'
    record.error = result.ok ? 'The take came back empty.' : result.error
    await this.save(record)
    this.deps.log('Dictation take failed', { id, reason: record.error })
    this.release({ id, text: record.live, clean: false, note: FAILED_NOTE })
  }

  private release(settled: Settled): void {
    const list = this.waiters.get(settled.id) ?? []
    this.waiters.delete(settled.id)
    for (const fn of list) fn(settled)
  }

  private jsonFile(id: string): string {
    return join(this.deps.dir, `${id}.json`)
  }

  private pcmFile(id: string): string {
    return join(this.deps.dir, `${id}.pcm`)
  }

  private async size(id: string): Promise<number | null> {
    try {
      return (await fsp.stat(this.pcmFile(id))).size
    } catch {
      return null
    }
  }

  private async load(id: string): Promise<TakeRecord | null> {
    if (!ID_PATTERN.test(id)) return null
    try {
      const record = JSON.parse(await fsp.readFile(this.jsonFile(id), 'utf8')) as TakeRecord
      this.records.set(id, record)
      return record
    } catch {
      return null
    }
  }

  private async save(record: TakeRecord): Promise<void> {
    const temp = `${this.jsonFile(record.id)}.tmp`
    await fsp.writeFile(temp, JSON.stringify(record))
    await fsp.rename(temp, this.jsonFile(record.id))
  }
}
