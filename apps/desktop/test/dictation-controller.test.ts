import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyAliases } from '../src/main/memory/vocabulary'
import type { DictationCommand, DictationView } from '@agent/core'

import { DictationController, loudness, type DictationDeps, type TranscriberLike } from '../src/main/dictation/controller'

/** A transcriber the test drives: `say` is Google sending words, `finishWith` what the last words settle to. */
class FakeTranscriber implements TranscriberLike {
  audioBytes = 0
  closed = false
  flushed = false
  startResult: Promise<void>
  finishResult: Promise<string> | null = null
  private failStart: ((error: Error) => void) | null = null
  private okStart: (() => void) | null = null
  private settled = ''
  private guess = ''

  constructor(private readonly handlers: { onUpdate: (text: string, interim: string) => void; onDrop: (reason: string) => void }) {
    this.startResult = new Promise((resolve, reject) => {
      this.okStart = resolve
      this.failStart = reject
    })
  }

  connect(): void {
    this.okStart?.()
  }

  refuse(message: string): void {
    this.failStart?.(new Error(message))
  }

  drop(reason: string): void {
    this.handlers.onDrop(reason)
  }

  say(settled: string, guess = ''): void {
    this.settled = settled
    this.guess = guess
    this.handlers.onUpdate(settled, guess)
  }

  start(): Promise<void> {
    return this.startResult
  }

  audio(pcm: Buffer): void {
    this.audioBytes += pcm.length
  }

  async finish(): Promise<string> {
    if (this.finishResult !== null) return this.finishResult
    return [this.settled, this.guess].filter((part) => part !== '').join(' ')
  }

  flush(): void {
    this.flushed = true
  }

  close(): void {
    this.closed = true
  }

  text(): string {
    return [this.settled, this.guess].filter((part) => part !== '').join(' ')
  }
}

const LOUD = Buffer.alloc(3200)
for (let index = 0; index < 1600; index += 1) LOUD.writeInt16LE(index % 2 === 0 ? 8000 : -8000, index * 2)
const QUIET = Buffer.alloc(3200)

interface Harness {
  controller: DictationController
  deps: DictationDeps
  views: DictationView[]
  commands: DictationCommand[]
  pill: string[]
  typed: string[]
  cleaned: string[]
  batched: number[]
  held: Map<string, () => void>
  masks: number
  transcriber: () => FakeTranscriber
}

function harness(overrides: Partial<DictationDeps> = {}): Harness {
  const views: DictationView[] = []
  const commands: DictationCommand[] = []
  const pill: string[] = []
  const typed: string[] = []
  const cleaned: string[] = []
  const batched: number[] = []
  const held = new Map<string, () => void>()
  const transcribers: FakeTranscriber[] = []
  const state = { masks: 0 }
  const deps: DictationDeps = {
    hasKey: () => true,
    transcriber: (handlers) => {
      const fake = new FakeTranscriber(handlers)
      transcribers.push(fake)
      return fake
    },
    batch: async (pcm) => {
      batched.push(pcm.length)
      return { ok: true, text: 'From the whole recording.' }
    },
    cleanUp: async (text) => {
      cleaned.push(text)
      return 'Cleaned up text.'
    },
    type: async (text) => {
      typed.push(text)
      return 'pasted'
    },
    mask: () => {
      state.masks += 1
    },
    pill: {
      show: () => pill.push('show'),
      hide: () => pill.push('hide'),
      view: (view) => views.push(view),
      command: (command) => commands.push(command),
    },
    hold: (accelerator, callback) => {
      if (held.has(accelerator)) return null
      held.set(accelerator, callback)
      return () => held.delete(accelerator)
    },
    keys: () => ({ dictate: 'Alt+Space', cleanSwitch: 'Alt+C' }),
    format: (accelerator) => accelerator.replace('CommandOrControl', 'Ctrl'),
    ...overrides,
  }
  const controller = new DictationController(deps)
  return {
    controller,
    deps,
    views,
    commands,
    pill,
    typed,
    cleaned,
    batched,
    held,
    get masks() {
      return state.masks
    },
    transcriber: () => {
      const last = transcribers.at(-1)
      if (last === undefined) throw new Error('no transcriber yet')
      return last
    },
  }
}

/** Start a dictation, connect, and let the pill's microphone report in. */
async function listening(h: Harness, mode: 'plain' | 'clean' = 'plain'): Promise<number> {
  h.controller.toggle(mode)
  const command = h.commands.at(-1)
  if (command?.type !== 'start') throw new Error('expected a start command')
  h.transcriber().connect()
  h.controller.micState(command.session, true, '')
  await vi.advanceTimersByTimeAsync(0)
  return command.session
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DictationController', () => {
  it('press, speak, press again: the words are typed where the cursor is', async () => {
    const h = harness()
    const session = await listening(h)
    expect(h.pill).toEqual(['show'])
    expect(h.controller.phase).toBe('listening')
    expect(h.views.at(-1)).toMatchObject({ phase: 'listening', message: 'Alt+Space to stop', switchKeys: 'Alt+C', clean: false })
    expect([...h.held.keys()].sort()).toEqual(['Alt+C', 'Escape'])

    h.controller.audio(session, LOUD)
    expect(h.transcriber().audioBytes).toBe(LOUD.length)
    h.transcriber().say('Send the proposal to Thandi.', 'before Friday')
    expect(h.views.at(-1)).toMatchObject({ phase: 'listening', text: 'Send the proposal to Thandi.', interim: 'before Friday' })

    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.commands.at(-1)).toEqual({ type: 'stop', session })
    expect(h.typed).toEqual(['Send the proposal to Thandi. before Friday'])
    expect(h.cleaned).toEqual([])
    expect(h.views.at(-1)).toMatchObject({ phase: 'done', message: 'Typed' })
    expect(h.held.size).toBe(0)
    expect(h.masks).toBe(2)
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.pill.at(-1)).toBe('hide')
    expect(h.controller.phase).toBe('idle')
  })

  it('puts names memory knows were mis-heard right, in a plain dictation and before clean-up', async () => {
    const fixNames = async (text: string): Promise<string> => applyAliases(text, { names: ['LondaCorp'], aliases: [{ heard: 'Londercorp', name: 'LondaCorp' }] })
    const plain = harness({ fixNames })
    await listening(plain)
    plain.transcriber().say('Send the estimate to Londercorp.')
    plain.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(0)
    expect(plain.typed).toEqual(['Send the estimate to LondaCorp.'])

    const clean = harness({ fixNames })
    await listening(clean, 'clean')
    clean.transcriber().say('so um send it to londercorp')
    clean.controller.toggle('clean')
    await vi.advanceTimersByTimeAsync(0)
    expect(clean.cleaned).toEqual(['so um send it to LondaCorp'])
  })

  it('the clean-up shortcut sends the words through the clean-up model first', async () => {
    const h = harness()
    await listening(h, 'clean')
    expect(h.views.at(-1)).toMatchObject({ clean: true })
    h.transcriber().say('so um move it to Friday')
    h.controller.toggle('clean')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.cleaned).toEqual(['so um move it to Friday'])
    expect(h.typed).toEqual(['Cleaned up text.'])
    expect(h.views.some((view) => view.phase === 'cleaning')).toBe(true)
    expect(h.views.at(-1)).toMatchObject({ phase: 'done', message: 'Cleaned up and typed' })
  })

  it('Alt+C while dictating switches this dictation to clean-up (Alt+Space+C), and back', async () => {
    const h = harness()
    await listening(h)
    h.held.get('Alt+C')?.()
    expect(h.views.at(-1)).toMatchObject({ phase: 'listening', clean: true })
    h.held.get('Alt+C')?.()
    expect(h.views.at(-1)).toMatchObject({ clean: false })
    h.held.get('Alt+C')?.()
    h.transcriber().say('uh hello')
    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.cleaned).toEqual(['uh hello'])
    expect(h.typed).toEqual(['Cleaned up text.'])
  })

  it('the clean-up shortcut during a plain dictation switches it rather than stopping it', async () => {
    const h = harness()
    await listening(h)
    h.controller.toggle('clean')
    expect(h.controller.phase).toBe('listening')
    expect(h.views.at(-1)).toMatchObject({ clean: true })
    h.transcriber().say('hello')
    h.controller.toggle('clean')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.typed).toEqual(['Cleaned up text.'])
  })

  it('stops by itself after a few quiet seconds once words were heard', async () => {
    const h = harness({ silenceMs: 4000 })
    const session = await listening(h)
    h.controller.audio(session, LOUD)
    h.transcriber().say('Short note.')
    for (let index = 0; index < 10; index += 1) {
      await vi.advanceTimersByTimeAsync(300)
      h.controller.audio(session, QUIET)
    }
    expect(h.controller.phase).toBe('listening')
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.typed).toEqual(['Short note.'])
  })

  it('stops after a longer quiet when nothing at all was said, and says so', async () => {
    const h = harness({ nothingMs: 10_000 })
    await listening(h)
    await vi.advanceTimersByTimeAsync(10_500)
    expect(h.typed).toEqual([])
    expect(h.views.at(-1)).toMatchObject({ phase: 'notice', message: 'Nothing was heard. Try again a little closer to the microphone.' })
  })

  it('pressing again while the last words settle types what was heard at once', async () => {
    const h = harness()
    await listening(h)
    h.transcriber().say('Almost there')
    let settle: (text: string) => void = () => undefined
    h.transcriber().finishResult = new Promise((resolve) => {
      settle = resolve
    })
    h.controller.toggle('plain')
    expect(h.controller.phase).toBe('finishing')
    h.controller.toggle('plain')
    expect(h.transcriber().flushed).toBe(true)
    // A third press while typing is ignored.
    settle('Almost there')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.typed).toEqual(['Almost there'])
    expect(h.controller.phase).toBe('idle')
  })

  it('without a Gemini key it points to Settings and does not listen', async () => {
    const h = harness({ hasKey: () => false })
    h.controller.toggle('plain')
    expect(h.commands).toEqual([])
    expect(h.views.at(-1)).toMatchObject({ phase: 'notice', message: 'Add a Gemini key in Settings, Voice, to dictate.' })
    expect(h.pill).toEqual(['show'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.pill.at(-1)).toBe('hide')
  })

  it('a blocked microphone ends it with the reason', async () => {
    const h = harness()
    h.controller.toggle('plain')
    const command = h.commands.at(-1)
    if (command?.type !== 'start') throw new Error('expected start')
    h.controller.micState(command.session, false, 'The microphone is off or blocked. Allow it for Agent in your system settings.')
    expect(h.views.at(-1)).toMatchObject({ phase: 'error', message: 'The microphone is off or blocked. Allow it for Agent in your system settings.' })
    expect(h.transcriber().closed).toBe(true)
    expect(h.held.size).toBe(0)
    expect(h.controller.phase).toBe('idle')
  })

  it('when the live model cannot start, keeps recording and transcribes the whole recording at the end', async () => {
    const h = harness()
    h.controller.toggle('plain')
    const command = h.commands.at(-1)
    if (command?.type !== 'start') throw new Error('expected start')
    h.transcriber().refuse('Gemini did not accept the transcription setup.')
    h.controller.micState(command.session, true, '')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.views.at(-1)?.message).toBe('Alt+Space to stop. Words show when you stop.')
    h.controller.audio(command.session, LOUD)
    h.controller.audio(command.session, LOUD)
    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.batched).toEqual([LOUD.length * 2])
    expect(h.typed).toEqual(['From the whole recording.'])
  })

  it('a dropped connection falls back the same way; no network at all says so and types nothing', async () => {
    const h = harness({ batch: async () => ({ ok: false, error: 'Could not reach Gemini. Check the connection.' }) })
    const session = await listening(h)
    h.controller.audio(session, LOUD)
    h.transcriber().drop('Could not reach Gemini. Check the connection.')
    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.typed).toEqual([])
    expect(h.views.at(-1)).toMatchObject({ phase: 'error', message: 'Could not reach Gemini. Check the connection. Nothing was typed.' })
  })

  it('a dropped connection keeps the words already heard when the fallback fails too', async () => {
    const h = harness({ batch: async () => ({ ok: false, error: 'offline' }) })
    const session = await listening(h)
    h.controller.audio(session, LOUD)
    h.transcriber().say('Heard before the drop.')
    h.transcriber().drop('dropped')
    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.typed).toEqual(['Heard before the drop.'])
  })

  it('when the clean-up fails the words are typed as said, with a note', async () => {
    const h = harness({
      cleanUp: async () => {
        throw new Error('quota')
      },
    })
    await listening(h, 'clean')
    h.transcriber().say('um hello')
    h.controller.toggle('clean')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.typed).toEqual(['um hello'])
    expect(h.views.at(-1)).toMatchObject({ phase: 'done', message: 'Could not clean up, so it was typed as said.' })
  })

  it('when the keys cannot be sent the words stay copied and the pill says how to paste', async () => {
    const h = harness({ type: async () => 'copied' })
    await listening(h)
    h.transcriber().say('Copy me.')
    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.views.at(-1)).toMatchObject({ phase: 'notice', message: 'Copied. Press Ctrl+V to paste it.' })
  })

  it('Esc cancels: nothing typed, the pill goes', async () => {
    const h = harness()
    await listening(h)
    h.transcriber().say('never mind')
    h.held.get('Escape')?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.typed).toEqual([])
    expect(h.pill.at(-1)).toBe('hide')
    expect(h.transcriber().closed).toBe(true)
    expect(h.controller.phase).toBe('idle')
  })

  it('ignores audio and mic reports from an older dictation', async () => {
    const h = harness()
    const first = await listening(h)
    h.transcriber().say('one')
    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(0)
    const second = await listening(h)
    expect(second).toBe(first + 1)
    h.controller.audio(first, LOUD)
    expect(h.transcriber().audioBytes).toBe(0)
    h.controller.micState(first, false, 'old')
    expect(h.controller.phase).toBe('listening')
  })
})

describe('DictationController: never an endless wait', () => {
  /** A live session that drops, so the stop goes to the whole recording, which `batch` decides. */
  async function droppedWithAudio(h: Harness): Promise<number> {
    const session = await listening(h)
    h.controller.audio(session, LOUD)
    h.controller.audio(session, LOUD)
    h.transcriber().drop('dropped')
    return session
  }

  it('a transcription that never answers ends at the limit with an error, the seconds counter and Retry', async () => {
    const signals: AbortSignal[] = []
    let answer = false
    const h = harness({
      finishLimitMs: () => 20_000,
      batch: (pcm, signal) => {
        signals.push(signal)
        if (answer) return Promise.resolve({ ok: true, text: 'Second time lucky.' })
        return new Promise(() => undefined)
      },
    })
    await droppedWithAudio(h)
    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(0)
    const finishing = h.views.at(-1)
    expect(finishing).toMatchObject({ phase: 'finishing', limitMs: 20_000, message: 'Esc to cancel' })
    expect(typeof finishing?.since).toBe('number')
    expect(h.held.has('Escape')).toBe(true)
    await vi.advanceTimersByTimeAsync(19_000)
    expect(h.controller.phase).toBe('finishing')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(signals[0]?.aborted).toBe(true)
    expect(h.controller.phase).toBe('idle')
    expect(h.typed).toEqual([])
    expect(h.views.at(-1)).toMatchObject({ phase: 'error', canRetry: true, message: 'The words did not come back within 20 seconds. Nothing was typed.' })
    expect(h.controller.canRetry).toBe(true)

    // Retry sends the kept recording again and types it.
    answer = true
    await h.controller.retry()
    expect(h.typed).toEqual(['Second time lucky.'])
    expect(h.views.at(-1)).toMatchObject({ phase: 'done', message: 'Typed' })
    expect(h.controller.canRetry).toBe(false)
    expect(h.held.size).toBe(0)
  })

  it('Esc while the words are worked out stops waiting, types nothing, and keeps the recording', async () => {
    const lengths: number[] = []
    let answer = false
    const h = harness({
      batch: (pcm) => {
        lengths.push(pcm.length)
        return answer ? Promise.resolve({ ok: true, text: 'Kept and typed.' }) : new Promise(() => undefined)
      },
    })
    await droppedWithAudio(h)
    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(3000)
    h.held.get('Escape')?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.controller.phase).toBe('idle')
    expect(h.typed).toEqual([])
    expect(h.views.at(-1)).toMatchObject({ phase: 'notice', message: 'Cancelled. Nothing was typed.', canRetry: true })

    // Clicking the pill retries.
    answer = true
    h.controller.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(lengths).toEqual([LOUD.length * 2, LOUD.length * 2])
    expect(h.typed).toEqual(['Kept and typed.'])
  })

  it('a failed transcription offers Retry; Esc puts the error away; a new dictation drops the kept recording', async () => {
    const h = harness({ batch: async () => ({ ok: false, error: 'Gemini is busy right now. Try again in a moment.' }) })
    await droppedWithAudio(h)
    h.controller.toggle('plain')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.views.at(-1)).toMatchObject({ phase: 'error', canRetry: true, message: 'Gemini is busy right now. Try again in a moment. Nothing was typed.' })
    expect(h.held.has('Escape')).toBe(true)
    h.held.get('Escape')?.()
    expect(h.pill.at(-1)).toBe('hide')
    expect(h.held.size).toBe(0)
    expect(h.controller.canRetry).toBe(true)
    await listening(h)
    expect(h.controller.canRetry).toBe(false)
  })

  it('a microphone that never reports in ends the dictation instead of waiting', async () => {
    const h = harness({ micStartMs: 5000 })
    h.controller.toggle('plain')
    expect(h.controller.phase).toBe('starting')
    await vi.advanceTimersByTimeAsync(5500)
    expect(h.controller.phase).toBe('idle')
    expect(h.views.at(-1)).toMatchObject({ phase: 'error', message: 'The microphone did not start. Try again.' })
    expect(h.held.size).toBe(0)
  })

  it('the default limit grows with the recording and has a ceiling', async () => {
    const { defaultFinishLimitMs } = await import('../src/main/dictation/controller')
    expect(defaultFinishLimitMs(0)).toBe(30_000)
    expect(defaultFinishLimitMs(16_000 * 2 * 60)).toBe(60_000)
    expect(defaultFinishLimitMs(16_000 * 2 * 600)).toBe(100_000)
  })
})

describe('loudness', () => {
  it('is the RMS of the samples, 0 to 1', () => {
    expect(loudness(QUIET)).toBe(0)
    expect(loudness(LOUD)).toBeCloseTo(8000 / 32768, 3)
    expect(loudness(Buffer.alloc(0))).toBe(0)
  })
})
