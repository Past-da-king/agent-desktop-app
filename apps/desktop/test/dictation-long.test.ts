/**
 * 29 Oct 2026: an 89-second dictation was lost. It stopped after quiet, a cancel came 478 ms later (the Stop waiting
 * button takes Done's place under the pointer), and the retry of the whole recording in one call took 74 s and was
 * aborted at the finishing limit. A finished recording must always end with its words in the box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DictationCommand, DictationView } from '@agent/core'

import { CANCEL_GRACE_MS, DictationController, defaultFinishLimitMs, type BatchResult, type DictationDeps, type TranscriberLike } from '../src/main/dictation/controller'
import { CHUNK_MAX_BYTES, splitAtQuiet, transcribeInChunks } from '../src/main/dictation/chunks'

const SECOND = 16_000 * 2

/** PCM16 of `seconds`: loud speech, with a quiet gap of `gapMs` every `everyS` seconds. */
function speech(seconds: number, everyS = 7, gapMs = 400): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * SECOND))
  for (let sample = 0; sample < pcm.length / 2; sample += 1) {
    const t = sample / 16_000
    const inGap = t % everyS > everyS - gapMs / 1000
    pcm.writeInt16LE(inGap ? 0 : sample % 2 === 0 ? 9000 : -9000, sample * 2)
  }
  return pcm
}

class LiveFake implements TranscriberLike {
  heard = ''
  closed = false
  constructor(
    private readonly handlers: { onUpdate: (text: string, interim: string) => void },
    private readonly finishMs = 900,
  ) {}
  start(): Promise<void> {
    return Promise.resolve()
  }
  audio(): void {}
  async finish(): Promise<string> {
    // The live model settles its last words in a moment.
    await new Promise((resolve) => setTimeout(resolve, this.finishMs))
    return this.heard
  }
  flush(): void {}
  close(): void {
    this.closed = true
  }
  text(): string {
    return this.heard
  }
  say(text: string): void {
    this.heard = text
    this.handlers.onUpdate(text, '')
  }
}

function harness(overrides: Partial<DictationDeps> = {}, finishMs = 900) {
  const typed: string[] = []
  const views: DictationView[] = []
  const commands: DictationCommand[] = []
  const logs: string[] = []
  const held = new Map<string, () => void>()
  let live: LiveFake | null = null
  const deps: DictationDeps = {
    hasKey: () => true,
    transcriber: (handlers) => (live = new LiveFake(handlers, finishMs)),
    batch: async () => ({ ok: true, text: 'From the whole recording.' }),
    cleanUp: async (text) => text,
    type: async (text) => {
      typed.push(text)
      return 'inserted'
    },
    mask: () => undefined,
    pill: { show: () => undefined, hide: () => undefined, view: (view) => views.push(view), command: (command) => commands.push(command) },
    hold: (accelerator, callback) => {
      held.set(accelerator, callback)
      return () => held.delete(accelerator)
    },
    keys: () => ({ dictate: 'Alt+Space', cleanSwitch: null }),
    format: (accelerator) => accelerator,
    log: (message) => logs.push(message),
    ...overrides,
  }
  const controller = new DictationController(deps)
  return {
    controller,
    typed,
    views,
    logs,
    held,
    live: () => {
      if (live === null) throw new Error('no live session')
      return live
    },
    async listening(): Promise<number> {
      controller.toggle('plain')
      const command = commands.at(-1)
      if (command?.type !== 'start') throw new Error('expected a start')
      controller.micState(command.session, true, '')
      await vi.advanceTimersByTimeAsync(0)
      return command.session
    },
  }
}

const LOUD = speech(0.1, 100, 0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a dictation that stopped after quiet', () => {
  it('a cancel 478 ms after the stop (the click meant for Done) is ignored, and the words are typed', async () => {
    const h = harness()
    const session = await h.listening()
    h.controller.audio(session, LOUD)
    h.live().say('Eighty-nine seconds of what I wanted to say.')
    // Quiet for over 4 s: it stops by itself.
    await vi.advanceTimersByTimeAsync(4_500)
    expect(h.controller.phase).toBe('finishing')
    await vi.advanceTimersByTimeAsync(478)
    h.controller.cancel()
    expect(h.controller.phase).toBe('finishing')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.typed).toEqual(['Eighty-nine seconds of what I wanted to say.'])
    expect(h.logs).toContain('Dictation cancel ignored, it came just after the stop')
  })

  it('Esc just after the stop is ignored the same way; a cancel after the grace still cancels', async () => {
    const h = harness({ batch: () => new Promise<BatchResult>(() => undefined) })
    const session = await h.listening()
    h.controller.audio(session, LOUD)
    h.live().say('keep me')
    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(100)
    h.held.get('Escape')?.()
    expect(h.controller.phase).toBe('finishing')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.typed).toEqual(['keep me'])

    // A slow finish: a cancel well after the stop is a real cancel.
    const slow = harness({ batch: () => new Promise<BatchResult>(() => undefined) })
    const second = await slow.listening()
    slow.controller.audio(second, LOUD)
    slow.live().say('')
    slow.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS + 500)
    slow.controller.cancel()
    expect(slow.controller.phase).toBe('idle')
    expect(slow.views.at(-1)).toMatchObject({ phase: 'notice', canRetry: true })
  })

  it('a Retry that cannot transcribe the recording still types the words the live session heard', async () => {
    let calls = 0
    const h = harness({
      batch: async () => {
        calls += 1
        return { ok: false, error: 'Gemini is busy.' }
      },
    }, 5_000)
    const session = await h.listening()
    h.controller.audio(session, LOUD)
    h.live().say('What the live session heard.')
    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS + 10)
    h.controller.cancel()
    expect(h.controller.canRetry).toBe(true)
    await h.controller.retry()
    expect(calls).toBe(1)
    expect(h.typed).toEqual(['What the live session heard.'])
  })
})

describe('a long recording in pieces', () => {
  it('cuts at quiet moments, never longer than two minutes, and loses no audio', () => {
    const pcm = speech(300)
    const pieces = splitAtQuiet(pcm)
    expect(pieces.length).toBe(3)
    expect(pieces.every((piece) => piece.length <= CHUNK_MAX_BYTES && piece.length % 2 === 0)).toBe(true)
    expect(pieces.reduce((sum, piece) => sum + piece.length, 0)).toBe(pcm.length)
    // Each cut lands in a quiet gap.
    let offset = 0
    for (const piece of pieces.slice(0, -1)) {
      offset += piece.length
      expect(pcm.readInt16LE(offset - (offset % 2))).toBe(0)
    }
    // No quiet at all: hard cuts at two minutes.
    const hard = splitAtQuiet(speech(290, 1000, 0)).map((piece) => piece.length)
    expect(hard.length).toBe(3)
    expect(hard[0]).toBeLessThanOrEqual(CHUNK_MAX_BYTES)
    expect(hard.reduce((sum, bytes) => sum + bytes, 0)).toBe(290 * SECOND)
  })

  it('230 s that would take 184 s in one call comes back inside the finishing limit, in order', async () => {
    const pcm = speech(230)
    // A piece takes 0.8 s per second of audio (what 29 Oct measured: 74 s for 89 s in one call).
    const one = (piece: Buffer, signal: AbortSignal): Promise<BatchResult> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true, text: `[${Math.round(piece.length / SECOND)}s]` }), (piece.length / SECOND) * 800)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      })
    const updates: string[] = []
    const limit = defaultFinishLimitMs(pcm.length)
    const started = Date.now()
    const done = transcribeInChunks(pcm, one, { signal: new AbortController().signal, onUpdate: (text) => updates.push(text) })
    await vi.advanceTimersByTimeAsync(limit)
    const result = await done
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text.split(' ').length).toBe(2)
    expect(updates.at(-1)).toBe(result.text)
    expect(updates[0]?.split(' ').length).toBeLessThan(2)
    // Two pieces side by side: about 92 s of work against the limit.
    expect(Date.now() - started).toBeLessThanOrEqual(limit)
  })

  it('a piece that fails is tried once more; one that fails twice fails the whole, and an abort stops it', async () => {
    let failures = 1
    const flaky = async (): Promise<BatchResult> => {
      if (failures > 0) {
        failures -= 1
        return { ok: false, error: 'busy' }
      }
      return { ok: true, text: 'ok' }
    }
    const logs: string[] = []
    const retried = await transcribeInChunks(speech(250), flaky, { signal: new AbortController().signal, log: (message) => logs.push(message) })
    expect(retried).toEqual({ ok: true, text: 'ok ok ok' })
    expect(logs).toContain('Dictation piece failed')

    const broken = await transcribeInChunks(speech(250), async () => ({ ok: false, error: 'Gemini is busy.' }), { signal: new AbortController().signal })
    expect(broken).toEqual({ ok: false, error: 'Gemini is busy.' })

    const stop = new AbortController()
    stop.abort()
    expect(await transcribeInChunks(speech(250), async () => ({ ok: true, text: 'x' }), { signal: stop.signal })).toEqual({ ok: false, error: 'Cancelled.' })
  })
})
