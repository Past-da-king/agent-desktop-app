/**
 * Dictation anywhere: the shortcut starts listening, the words appear in a small pill near the bottom of the
 * screen, and when it stops they are typed where the cursor is, in whatever app is in front.
 *
 *   Dictation shortcut (Alt+Space)          idle: start. Listening: stop and type. Finishing: type now, do not wait.
 *   Clean-up shortcut (Ctrl+Alt+C)          idle: start in clean-up mode. Listening plainly: switch to clean-up.
 *                                           Listening in clean-up: stop and type.
 *   Clean-up switch (Alt+C, held only while listening; the dictation shortcut's modifiers with C)
 *                                           turns clean-up on or off for this dictation.
 *   Esc (held only while listening)         cancel: nothing is typed.
 *   Quiet for a while                       stops by itself, as if the shortcut was pressed.
 *
 * The microphone lives in the pill's window (it never takes focus, so the app in front keeps the keyboard);
 * this class only sees its audio. Words stream from Google's live transcription model; every chunk is also kept,
 * so a live session that cannot start or drops falls back to one transcription of the whole recording.
 * Everything with side effects is injected, so tests run the whole flow with fakes and fake timers.
 */
import type { DictationCommand, DictationPhase, DictationView } from '@agent/core'

import type { TypeOutcome } from './paste'

export type DictationMode = 'plain' | 'clean'

export interface TranscriberLike {
  start(): Promise<void>
  audio(pcm: Buffer): void
  finish(waitMs: number): Promise<string>
  flush(): void
  close(): void
  text(): string
}

export interface PillLike {
  show(): void
  hide(): void
  view(view: DictationView): void
  command(command: DictationCommand): void
}

export interface DictationDeps {
  hasKey: () => boolean
  transcriber: (handlers: { onUpdate: (text: string, interim: string) => void; onDrop: (reason: string) => void }) => TranscriberLike
  /** The whole recording in one call: the fallback when the live session is not there. */
  batch: (pcm: Buffer) => Promise<{ ok: true; text: string } | { ok: false; error: string }>
  cleanUp: (text: string) => Promise<string>
  /** Types the words where the cursor is. 'inserted' means straight into one of the app's own windows. */
  type: (text: string) => Promise<TypeOutcome | 'inserted'>
  /** Hides a held Alt from the app in front (Windows); called on every shortcut press. */
  mask: () => void
  pill: PillLike
  hold: (accelerator: string, callback: () => void) => (() => void) | null
  /** The dictation shortcut and the clean-up switch, as accelerators ('' or null when there is none). */
  keys: () => { dictate: string; cleanSwitch: string | null }
  format: (accelerator: string) => string
  now?: () => number
  /** Quiet this long after words were heard stops the dictation. */
  silenceMs?: number
  /** Nothing at all heard this long stops it too. */
  nothingMs?: number
  maxMs?: number
  finalWaitMs?: number
  log?: (message: string, fields?: Record<string, string | number | boolean>) => void
}

type State = 'idle' | 'starting' | 'listening' | 'finishing' | 'cleaning' | 'typing'

const LOUD = 0.02 // RMS of 16-bit samples, 0..1; quiet rooms through noise suppression sit well under it
const MAX_RECORDING_BYTES = 16_000 * 2 * 60 * 10

interface Session {
  id: number
  clean: boolean
  transcriber: TranscriberLike
  live: boolean
  liveFailed: boolean
  chunks: Buffer[]
  bytes: number
  text: string
  interim: string
  startedAt: number
  lastActivity: number
  heard: boolean
  releases: Array<() => void>
  timer: ReturnType<typeof setInterval> | null
}

export class DictationController {
  private readonly deps: DictationDeps
  private readonly now: () => number
  private state: State = 'idle'
  private session: Session | null = null
  private sequence = 0
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  private lastView: DictationView = { phase: 'hidden', clean: false, text: '', interim: '', message: '', switchKeys: '' }

  constructor(deps: DictationDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  get phase(): State {
    return this.state
  }

  /** The view the pill should show now (for a pill window that just loaded). */
  currentView(): DictationView {
    return { ...this.lastView }
  }

  /** The command the pill's microphone should follow now. */
  currentCommand(): DictationCommand | null {
    const session = this.session
    if (session === null) return null
    return this.state === 'starting' || this.state === 'listening' ? { type: 'start', session: session.id } : { type: 'stop', session: session.id }
  }

  /** A dictation shortcut was pressed. */
  toggle(mode: DictationMode): void {
    this.deps.mask()
    const session = this.session
    if (this.state === 'idle' || session === null) {
      this.start(mode)
      return
    }
    if (this.state === 'starting' || this.state === 'listening') {
      if (mode === 'clean' && !session.clean) {
        session.clean = true
        this.log('Dictation switched to clean-up')
        this.show('listening')
        return
      }
      void this.finish()
      return
    }
    if (this.state === 'finishing') {
      // Pressed again while the last words settle: type what has been heard, now.
      session.transcriber.flush()
    }
    // Cleaning up or typing: already on its way.
  }

  /** The clean-up switch, while listening. */
  switchClean(): void {
    this.deps.mask()
    const session = this.session
    if (session === null || (this.state !== 'starting' && this.state !== 'listening')) return
    session.clean = !session.clean
    this.show('listening')
  }

  /** Esc while listening: stop and type nothing. */
  cancel(): void {
    const session = this.session
    if (session === null || (this.state !== 'starting' && this.state !== 'listening')) return
    this.log('Dictation cancelled')
    this.end(session)
    this.deps.pill.hide()
    this.lastView = { ...this.lastView, phase: 'hidden' }
  }

  /** The pill was clicked. */
  stop(): void {
    if (this.state === 'starting' || this.state === 'listening') void this.finish()
  }

  /** The pill's microphone started, or could not. */
  micState(id: number, ok: boolean, message: string): void {
    const session = this.session
    if (session === null || session.id !== id || (this.state !== 'starting' && this.state !== 'listening')) return
    if (!ok) {
      this.log('Dictation microphone failed')
      this.end(session)
      this.flash('error', message.trim() || 'Could not use the microphone.', 5000)
      return
    }
    if (this.state === 'starting') {
      this.state = 'listening'
      session.lastActivity = this.now()
      this.show('listening')
    }
  }

  /** One chunk of 16 kHz mono PCM16 from the pill. */
  audio(id: number, pcm: Buffer): void {
    const session = this.session
    if (session === null || session.id !== id || (this.state !== 'starting' && this.state !== 'listening')) return
    if (session.bytes + pcm.length > MAX_RECORDING_BYTES) return
    session.chunks.push(pcm)
    session.bytes += pcm.length
    if (!session.liveFailed) session.transcriber.audio(pcm)
    if (loudness(pcm) > LOUD) {
      session.heard = true
      session.lastActivity = this.now()
    }
  }

  dispose(): void {
    const session = this.session
    if (session !== null) this.end(session)
    if (this.hideTimer !== null) clearTimeout(this.hideTimer)
  }

  // ---- the flow --------------------------------------------------------------------------------

  private start(mode: DictationMode): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    if (!this.deps.hasKey()) {
      this.flash('notice', 'Add a Gemini key in Settings, Voice, to dictate.', 5000)
      return
    }
    this.sequence += 1
    const id = this.sequence
    const transcriber = this.deps.transcriber({
      onUpdate: (text, interim) => {
        const current = this.session
        if (current === null || current.id !== id) return
        current.text = text
        current.interim = interim
        current.heard = true
        current.lastActivity = this.now()
        if (this.state === 'listening' || this.state === 'starting' || this.state === 'finishing') this.show(this.state === 'finishing' ? 'finishing' : 'listening')
      },
      onDrop: (reason) => {
        const current = this.session
        if (current === null || current.id !== id) return
        this.log('Dictation live session dropped', { reason })
        current.liveFailed = true
      },
    })
    const session: Session = {
      id,
      clean: mode === 'clean',
      transcriber,
      live: false,
      liveFailed: false,
      chunks: [],
      bytes: 0,
      text: '',
      interim: '',
      startedAt: this.now(),
      lastActivity: this.now(),
      heard: false,
      releases: [],
      timer: null,
    }
    this.session = session
    this.state = 'starting'
    this.log('Dictation started', { clean: session.clean })
    this.show('starting')
    this.deps.pill.show()
    this.deps.pill.command({ type: 'start', session: id })

    transcriber.start().then(
      () => {
        if (this.session === session) session.live = true
      },
      (error: unknown) => {
        if (this.session !== session) return
        // Keep recording: the whole recording is transcribed in one go when it stops.
        session.liveFailed = true
        this.log('Dictation live session could not start', { reason: error instanceof Error ? error.message : 'unknown' })
        if (this.state === 'listening' || this.state === 'starting') this.show(this.state)
      },
    )

    const keys = this.deps.keys()
    if (keys.cleanSwitch !== null && keys.cleanSwitch !== '') {
      const release = this.deps.hold(keys.cleanSwitch, () => this.switchClean())
      if (release !== null) session.releases.push(release)
    }
    const escape = this.deps.hold('Escape', () => this.cancel())
    if (escape !== null) session.releases.push(escape)

    session.timer = setInterval(() => this.tick(session), 250)
  }

  private tick(session: Session): void {
    if (this.session !== session || this.state !== 'listening') return
    const now = this.now()
    const quiet = now - session.lastActivity
    if (now - session.startedAt > (this.deps.maxMs ?? 9.5 * 60_000)) {
      void this.finish()
    } else if (session.heard && quiet > (this.deps.silenceMs ?? 4000)) {
      this.log('Dictation stopped after quiet')
      void this.finish()
    } else if (!session.heard && now - session.startedAt > (this.deps.nothingMs ?? 10_000)) {
      void this.finish()
    }
  }

  private async finish(): Promise<void> {
    const session = this.session
    if (session === null || (this.state !== 'starting' && this.state !== 'listening')) return
    this.state = 'finishing'
    this.stopListening(session)
    this.show('finishing')

    let text = ''
    let problem = ''
    if (session.live && !session.liveFailed) {
      try {
        text = await session.transcriber.finish(this.deps.finalWaitMs ?? 2500)
      } catch {
        session.liveFailed = true
      }
    } else {
      // Never connected (or still connecting): the recording itself is the transcript's source.
      session.liveFailed = true
      session.transcriber.close()
    }
    if (session.liveFailed && session.bytes > 0) {
      const heardLive = session.transcriber.text()
      const whole = await this.deps.batch(Buffer.concat(session.chunks))
      if (whole.ok) text = whole.text
      else if (heardLive.trim() !== '') text = heardLive
      else problem = whole.error
    }
    if (this.session !== session) return
    text = text.trim()

    if (text === '') {
      this.finishSession(session)
      this.flash(problem === '' ? 'notice' : 'error', problem === '' ? 'Nothing was heard. Try again a little closer to the microphone.' : `${problem} Nothing was typed.`, problem === '' ? 3000 : 5000)
      return
    }

    let note = ''
    if (session.clean) {
      this.state = 'cleaning'
      session.text = text
      session.interim = ''
      this.show('cleaning')
      try {
        text = (await this.deps.cleanUp(text)).trim() || text
      } catch {
        note = 'Could not clean up, so it was typed as said.'
      }
    }

    this.state = 'typing'
    let outcome: TypeOutcome | 'inserted' = 'copied'
    try {
      outcome = await this.deps.type(text)
    } catch {
      outcome = 'copied'
    }
    this.log('Dictation typed', { outcome, characters: text.length, clean: session.clean })
    this.finishSession(session)
    if (outcome === 'copied') {
      this.flash('notice', `Copied. Press ${this.pasteKeys()} to paste it.`, 5000)
    } else {
      this.flash('done', note === '' ? (session.clean ? 'Cleaned up and typed' : 'Typed') : note, note === '' ? 1200 : 3500)
    }
  }

  private pasteKeys(): string {
    return this.deps.format('CommandOrControl+V')
  }

  private stopListening(session: Session): void {
    if (session.timer !== null) clearInterval(session.timer)
    session.timer = null
    for (const release of session.releases) release()
    session.releases = []
    this.deps.pill.command({ type: 'stop', session: session.id })
  }

  private end(session: Session): void {
    this.stopListening(session)
    session.transcriber.close()
    this.finishSession(session)
  }

  private finishSession(session: Session): void {
    if (this.session === session) this.session = null
    this.state = 'idle'
  }

  // ---- the pill ----------------------------------------------------------------------------------

  private show(phase: DictationPhase): void {
    const session = this.session
    const keys = this.deps.keys()
    let message = ''
    let switchKeys = ''
    if (phase === 'starting' || phase === 'listening') {
      const stop = keys.dictate === '' ? 'Click to stop' : `${this.deps.format(keys.dictate)} to stop`
      switchKeys = keys.cleanSwitch === null || keys.cleanSwitch === '' ? '' : this.deps.format(keys.cleanSwitch)
      message = session?.liveFailed === true ? `${stop}. Words show when you stop.` : stop
    }
    this.view({
      phase,
      clean: session?.clean ?? false,
      text: session?.text ?? '',
      interim: session?.interim ?? '',
      message,
      switchKeys,
    })
  }

  private flash(phase: 'done' | 'notice' | 'error', message: string, ms: number): void {
    this.view({ phase, clean: false, text: '', interim: '', message, switchKeys: '' })
    this.deps.pill.show()
    if (this.hideTimer !== null) clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      if (this.state !== 'idle') return
      this.lastView = { ...this.lastView, phase: 'hidden' }
      this.deps.pill.hide()
    }, ms)
  }

  private view(view: DictationView): void {
    this.lastView = view
    this.deps.pill.view(view)
  }

  private log(message: string, fields?: Record<string, string | number | boolean>): void {
    this.deps.log?.(message, fields)
  }
}

/** RMS of 16-bit little-endian samples, 0 to 1. */
export function loudness(pcm: Buffer): number {
  const count = Math.floor(pcm.length / 2)
  if (count === 0) return 0
  let sum = 0
  for (let index = 0; index < count; index += 1) {
    const sample = pcm.readInt16LE(index * 2) / 0x8000
    sum += sample * sample
  }
  return Math.sqrt(sum / count)
}
