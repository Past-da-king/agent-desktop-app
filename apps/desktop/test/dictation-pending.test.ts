import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FAILED_NOTE, PendingTakes, holdCapMs, type PendingDeps } from '../src/main/dictation/pending'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pending-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const pcm = Buffer.alloc(32_000 * 10, 1)
function make(overrides: Partial<PendingDeps> = {}) {
  const replaced: Array<[string, string]> = []
  const batch = vi.fn(async (_pcm: Buffer, _signal: AbortSignal, _extra: { names: string[]; languages: string[] }) => ({ ok: true as const, text: 'Clean text' }))
  const deps: PendingDeps = { dir, batch, replace: (take, text) => void replaced.push([take.id, text]), log: () => undefined, ...overrides }
  return { takes: new PendingTakes(deps), replaced, batch }
}

describe('instant send: pending takes', () => {
  it('accept returns at once, the pass replaces the message in place, and the agent gets the clean text', async () => {
    const { takes, replaced, batch } = make()
    const waiting = takes.settled('t1', 5000)
    await takes.accept({ id: 't1', chat: 'main', live: 'live caption', pcm })
    expect(await takes.settled('t1', 5000)).toEqual({ id: 't1', text: 'Clean text', clean: true, note: null })
    await waiting
    expect(replaced).toEqual([['t1', 'Clean text']])
    expect(batch).toHaveBeenCalledTimes(1)
  })

  it('is idempotent by recording id: the same take twice runs and replaces once', async () => {
    const { takes, replaced, batch } = make()
    await takes.accept({ id: 't1', chat: null, live: 'a', pcm })
    const again = await takes.accept({ id: 't1', chat: null, live: 'a', pcm })
    await takes.settled('t1', 5000)
    expect(again.duplicate).toBe(true)
    expect(batch).toHaveBeenCalledTimes(1)
    expect(replaced).toHaveLength(1)
  })

  it('a failed pass gives the agent the caption plus a note, keeps the take, and Retry runs it again', async () => {
    let ok = false
    const batch = vi.fn(async () => (ok ? { ok: true as const, text: 'Now clean' } : { ok: false as const, error: 'busy' }))
    const { takes, replaced } = make({ batch })
    await takes.accept({ id: 't2', chat: null, live: 'live words', pcm })
    expect(await takes.settled('t2', 5000)).toEqual({ id: 't2', text: 'live words', clean: false, note: FAILED_NOTE })
    expect((await takes.state('t2'))?.state).toBe('failed')
    ok = true
    expect(await takes.retry('t2')).toBe(true)
    expect(await takes.settled('t2', 5000)).toMatchObject({ text: 'Now clean', clean: true })
    expect(replaced).toEqual([['t2', 'Now clean']])
  })

  it('the agent never waits past the cap: the caption and the note come back', async () => {
    const batch = vi.fn(() => new Promise<never>(() => undefined))
    const { takes } = make({ batch })
    await takes.accept({ id: 't3', chat: null, live: 'still live', pcm })
    expect(await takes.settled('t3', 50)).toEqual({ id: 't3', text: 'still live', clean: false, note: FAILED_NOTE })
  })

  it('survives the app closing right after Send: a new start resumes the queued take once', async () => {
    const stuck = vi.fn(() => new Promise<never>(() => undefined))
    const first = make({ batch: stuck })
    await first.takes.accept({ id: 't4', chat: 'main', live: 'caption', pcm })
    // The app is closed here: nothing finished. A new start finds it on disk.
    const second = make()
    expect(await second.takes.resume()).toBe(1)
    expect(await second.takes.settled('t4', 5000)).toMatchObject({ text: 'Clean text', clean: true })
    expect(second.replaced).toEqual([['t4', 'Clean text']])
    // A finished take is not run again on the next start.
    const third = make()
    expect(await third.takes.resume()).toBe(0)
    expect(third.batch).not.toHaveBeenCalled()
  })

  it('the message can be in the chat before its audio: the agent waits for the take, then gets the clean text', async () => {
    const { takes, batch } = make()
    const early = takes.settled('t5', 5000, 'caption')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await takes.accept({ id: 't5', chat: 'main', live: 'caption', pcm, names: ['Strat Edge'], languages: ['en-ZA', 'zu-ZA'] })
    expect(await early).toEqual({ id: 't5', text: 'Clean text', clean: true, note: null })
    expect(batch.mock.calls[0]?.[2]).toEqual({ names: ['Strat Edge'], languages: ['en-ZA', 'zu-ZA'] })
  })

  it('no audio ever arrives: the agent still gets the caption and the note at the cap', async () => {
    const { takes } = make()
    expect(await takes.settled('t6', 30, 'only caption')).toEqual({ id: 't6', text: 'only caption', clean: false, note: FAILED_NOTE })
  })

  it('a resend of a failed take runs it again; a resend of a done take does nothing', async () => {
    let ok = false
    const batch = vi.fn(async () => (ok ? { ok: true as const, text: 'Fixed' } : { ok: false as const, error: 'busy' }))
    const { takes, replaced } = make({ batch })
    await takes.accept({ id: 't7', chat: null, live: 'c', pcm })
    await takes.settled('t7', 5000)
    ok = true
    expect((await takes.accept({ id: 't7', chat: null, live: 'c', pcm })).duplicate).toBe(true)
    expect(await takes.settled('t7', 5000)).toMatchObject({ text: 'Fixed', clean: true })
    await takes.accept({ id: 't7', chat: null, live: 'c', pcm })
    expect(replaced).toEqual([['t7', 'Fixed']])
  })

  it('the cap is 30 s plus half a second per second said, at most 100 s', () => {
    expect(holdCapMs(0)).toBe(30_000)
    expect(holdCapMs(32_000 * 60)).toBe(60_000)
    expect(holdCapMs(32_000 * 900)).toBe(100_000)
  })
})
