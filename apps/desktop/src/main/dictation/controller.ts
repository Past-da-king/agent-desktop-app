/**
 * Dictation anywhere: the shortcut starts listening, the words appear in a small pill near the bottom of the
 * screen (and in the app's own message box when that is where they go), and when it stops they are typed where
 * the cursor is, in whatever app is in front.
 *
 *   Dictation shortcut (Alt+Space)          idle: start. Listening: stop and type. Finishing: type now, do not wait.
 *   Clean-up shortcut (Ctrl+Alt+C)          idle: start in clean-up mode. Listening plainly: switch to clean-up.
 *                                           Listening in clean-up: stop and type.
 *   Clean-up switch (Alt+C, held only while listening; the dictation shortcut's modifiers with C)
 *                                           turns clean-up on or off for this dictation.
 *   Esc (held while listening or finishing) cancel: nothing is typed. While finishing the recording is kept.
 *   Quiet for a while                       stops by itself, as if the shortcut was pressed.
 *
 * Finishing never waits for ever: it has a hard limit that grows with the recording, the pill counts the seconds,
 * and when the words cannot be had (an error, the limit, Esc) the recording is kept so Retry can send it again.
 *
 * The pill is only for dictating into OTHER apps. A dictation into one of the app's own windows (its message box
 * microphone, or the shortcut while that window is in front) shows only that window's strip: the pill never
 * shows for it, not while listening, finishing, failing or retrying (see target.ts for the rule).
 *
 * The microphone lives in the pill's window (it never takes focus, so the app in front keeps the keyboard); it
 * runs there hidden for an in-app dictation. This class only sees its audio. Words stream from Google's live transcription model; every chunk is also kept,
 * so a live session that cannot start or drops falls back to the whole recording.
 * Everything with side effects is injected, so tests run the whole flow with fakes and fake timers.
 */
import type { DictationCommand, DictationPhase, DictationView } from '@agent/core'

import type { TypeOutcome } from './paste'
import type { DictationSurface } from './target'

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

export type BatchResult = { ok: true; text: string } | { ok: false; error: string }

export interface DictationDeps {
  hasKey: () => boolean
  transcriber: (handlers: { onUpdate: (text: string, interim: string) => void; onDrop: (reason: string) => void }) => TranscriberLike
  /**
   * The whole recording at once: the fallback when the live session is not there, and Retry. It must give up
   * when `signal` aborts; the controller aborts it at the finishing limit or on Esc.
   */
  batch: (pcm: Buffer, signal: AbortSignal, onUpdate?: (text: string, interim: string) => void) => Promise<BatchResult>
  cleanUp: (text: string) => Promise<string>
  /** Puts names memory knows were mis-heard right (memory/vocabulary.ts), on every dictation. */
  fixNames?: (text: string) => Promise<string>
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
  /** The microphone must report in this long after the start, or the dictation ends with an error. */
  micStartMs?: number
  /** The most finishing may take for a recording of `bytes`, from the stop to the words typed. */
  finishLimitMs?: (bytes: number) => number
  log?: (message: string, fields?: Record<string, string | number | boolean>) => void
  /** Called as a dictation starts, before anything else moves (the app notes where the cursor is). */
  began?: () => void
  /**
   * Asked right after began: 'app' when the words go into one of the app's own windows, which shows them in
   * its own strip, so the pill never shows; 'pill' (the default) for any other app.
   */
  surface?: () => DictationSurface
  /**
   * Writes this dictation to disk as it happens (recordings/store.ts), so a crash or a restart never loses it.
   * Asked once per dictation, right after `surface`. Null (or left out): nothing is written.
   */
  record?: (surface: DictationSurface) => RecordingSink | null
}

/** Where a dictation's audio and words go while it happens (a recordings/store.ts handle). */
export interface RecordingSink {
  audio(pcm: Buffer): void
  words(text: string, interim?: string): void
  stop(ended?: 'done' | 'cancelled' | 'failed'): Promise<void>
  final(text: string): Promise<void>
  failed(error: string): Promise<void>
}

type State = 'idle' | 'starting' | 'listening' | 'finishing' | 'cleaning' | 'typing'

const LOUD = 0.02 // RMS of 16-bit samples, 0..1; quiet rooms through noise suppression sit well under it
const MAX_RECORDING_BYTES = 16_000 * 2 * 60 * 10
const BYTES_PER_SECOND = 16_000 * 2
/** How long a failed dictation's error, with its Retry, stays up. The recording is kept until the next one. */
const RETRY_SHOW_MS = 20_000

/** The default finishing limit: 30 s, plus one for every two said, at most 100 s. */
export function defaultFinishLimitMs(bytes: number): number {
  return Math.min(100_000, Math.round(30_000 + (bytes / BYTES_PER_SECOND) * 500))
}

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
  phaseSince: number
  limitMs: number
  lastActivity: number
  heard: boolean
  /** Speech-loud audio was recorded (whatever the live model made of it). */
  loud: boolean
  releases: Array<() => void>
  escape: (() => void) | null
  abort: AbortController | null
  timer: ReturnType<typeof setInterval> | null
  /** The same dictation on disk; null when nothing is written. */
  rec: RecordingSink | null
}

interface Kept {
  chunks: Buffer[]
  bytes: number
  clean: boolean
  surface: DictationSurface
  rec: RecordingSink | null
}

/** The recording a retried dictation reads from: no live session behind it. */
const NO_LIVE: TranscriberLike = {
  start: () => Promise.reject(new Error('No live session.')),
  audio: () => undefined,
  finish: () => Promise.reject(new Error('No live session.')),
  flush: () => undefined,
  close: () => undefined,
  text: () => '',
}

const ABORTED = Symbol('aborted')

export class DictationController {
  private readonly deps: DictationDeps
  private readonly now: () => number
  private state: State = 'idle'
  private session: Session | null = null
  private sequence = 0
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  private kept: Kept | null = null
  private dismissRelease: (() => void) | null = null
  private lastView: DictationView = { phase: 'hidden', clean: false, text: '', interim: '', message: '', switchKeys: '' }
  /** What shows the current (or last) dictation: the pill, or the app window's own strip. */
  private surface: DictationSurface = 'pill'

  constructor(deps: DictationDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  get phase(): State {
    return this.state
  }

  /** True while a failed or cancelled dictation's recording is kept for Retry. */
  get canRetry(): boolean {
    return this.kept !== null && this.state === 'idle'
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

  /**
   * Esc. Listening: stop and type nothing. Finishing or cleaning up: stop waiting, type nothing, keep the
   * recording for Retry. Idle with an error up: put it away.
   */
  cancel(): void {
    const session = this.session
    if (session !== null && (this.state === 'starting' || this.state === 'listening')) {
      this.log('Dictation cancelled')
      // Nothing is typed, but what was said is kept on disk (its words are finished from the audio later).
      const rec = session.rec
      if (rec !== null) void rec.stop('cancelled').then(() => rec.failed('Cancelled before the words were final.'))
      this.end(session)
      this.deps.pill.hide()
      this.view({ ...this.lastView, phase: 'hidden', canRetry: false })
      return
    }
    if (session !== null && (this.state === 'finishing' || this.state === 'cleaning')) {
      this.log('Dictation cancelled while finishing', { ms: this.now() - session.phaseSince })
      this.keep(session)
      void session.rec?.failed('Cancelled while the words were coming.')
      session.abort?.abort(new Error('Cancelled.'))
      session.transcriber.close()
      this.finishSession(session)
      this.flash('notice', 'Cancelled. Nothing was typed.', RETRY_SHOW_MS, true)
      return
    }
    if (this.state === 'idle' && this.lastView.phase !== 'hidden') this.dismiss()
  }

  /** The pill was clicked: stop listening, or retry a dictation that failed. */
  stop(): void {
    if (this.state === 'starting' || this.state === 'listening') void this.finish()
    else if (this.canRetry) void this.retry()
  }

  /** Transcribe the kept recording again, and type it where the first try would have. */
  async retry(): Promise<void> {
    const kept = this.kept
    if (kept === null || this.state !== 'idle') return
    if (!this.deps.hasKey()) {
      this.flash('notice', 'Add a Gemini key in Settings, Voice, to dictate.', 5000)
      return
    }
    this.clearHide()
    this.releaseDismiss()
    this.kept = null
    this.surface = kept.surface
    this.sequence += 1
    const now = this.now()
    const session: Session = {
      id: this.sequence,
      clean: kept.clean,
      transcriber: NO_LIVE,
      live: false,
      liveFailed: true,
      chunks: kept.chunks,
      bytes: kept.bytes,
      text: '',
      interim: '',
      startedAt: now,
      phaseSince: now,
      limitMs: 0,
      lastActivity: now,
      heard: true,
      loud: true,
      releases: [],
      escape: null,
      abort: null,
      timer: null,
      rec: kept.rec,
    }
    this.session = session
    this.state = 'finishing'
    this.log('Dictation retried', { bytes: kept.bytes })
    session.escape = this.deps.hold('Escape', () => this.cancel())
    this.showPill()
    await this.complete(session)
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
      session.phaseSince = this.now()
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
    session.rec?.audio(pcm)
    if (!session.liveFailed) session.transcriber.audio(pcm)
    if (loudness(pcm) > LOUD) {
      session.loud = true
      session.heard = true
      session.lastActivity = this.now()
    }
  }

  dispose(): void {
    const session = this.session
    if (session !== null) {
      session.abort?.abort(new Error('Closing.'))
      this.end(session)
    }
    this.clearHide()
    this.releaseDismiss()
  }

  // ---- the flow --------------------------------------------------------------------------------

  private start(mode: DictationMode): void {
    this.clearHide()
    this.releaseDismiss()
    // Whatever an earlier dictation still shows (a pill, a strip) goes before this one picks where it goes.
    if (this.lastView.phase !== 'hidden') {
      this.view({ ...this.lastView, phase: 'hidden', canRetry: false })
      this.deps.pill.hide()
    }
    this.deps.began?.()
    this.surface = this.deps.surface?.() ?? 'pill'
    if (!this.deps.hasKey()) {
      this.flash('notice', 'Add a Gemini key in Settings, Voice, to dictate.', 5000)
      return
    }
    // A new dictation replaces whatever an earlier one kept for Retry.
    this.kept = null
    this.sequence += 1
    const id = this.sequence
    const transcriber = this.deps.transcriber({
      onUpdate: (text, interim) => {
        const current = this.session
        if (current === null || current.id !== id) return
        current.text = text
        current.interim = interim
        current.rec?.words(text, interim)
        current.heard = true
        current.lastActivity = this.now()
        if (this.state === 'listening' || this.state === 'starting' || this.state === 'finishing') this.show(this.state === 'finishing' ? 'finishing' : 'listening')
      },
      onDrop: (reason) => {
        const current = this.session
        if (current === null || current.id !== id) return
        this.log('Dictation live session dropped', { reason })
        current.liveFailed = true
        if (this.state === 'listening' || this.state === 'starting') this.show(this.state)
      },
    })
    const now = this.now()
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
      startedAt: now,
      phaseSince: now,
      limitMs: 0,
      lastActivity: now,
      heard: false,
      loud: false,
      releases: [],
      escape: null,
      abort: null,
      timer: null,
      rec: null,
    }
    try {
      session.rec = this.deps.record?.(this.surface) ?? null
    } catch {
      // A recording that cannot be written never stops the dictation itself.
      session.rec = null
    }
    this.session = session
    this.state = 'starting'
    this.log('Dictation started', { clean: session.clean })
    this.show('starting')
    this.showPill()
    // The microphone starts in the pill's window whether or not the pill shows.
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
    session.escape = this.deps.hold('Escape', () => this.cancel())

    session.timer = setInterval(() => this.tick(session), 250)
  }

  private tick(session: Session): void {
    if (this.session !== session) return
    const now = this.now()
    if (this.state === 'starting') {
      if (now - session.startedAt > (this.deps.micStartMs ?? 10_000)) {
        this.log('Dictation microphone never started')
        this.end(session)
        this.flash('error', 'The microphone did not start. Try again.', 5000)
      }
      return
    }
    if (this.state !== 'listening') return
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
    await this.complete(session)
  }

  /**
   * From the stop to the words typed, under one hard limit. Whatever happens it ends: typed, nothing heard, or an
   * error with the recording kept for Retry.
   */
  private async complete(session: Session): Promise<void> {
    const limit = (this.deps.finishLimitMs ?? defaultFinishLimitMs)(session.bytes)
    const abort = new AbortController()
    session.abort = abort
    session.phaseSince = this.now()
    session.limitMs = limit
    this.show('finishing')
    const timer = setTimeout(() => abort.abort(new Error('timeout')), limit)
    try {
      await this.produce(session, abort.signal)
    } finally {
      clearTimeout(timer)
    }
    // Every way through `produce` ends the session; one still open means the limit came first (or something
    // gave up without saying why). Either way it ends here, with the recording kept: never a wait that never ends.
    if (this.session === session) {
      this.log('Dictation took too long', { ms: this.now() - session.phaseSince, bytes: session.bytes, aborted: abort.signal.aborted })
      this.fail(session, abort.signal.aborted ? `The words did not come back within ${Math.round(limit / 1000)} seconds.` : 'Could not transcribe that.')
    }
  }

  private async produce(session: Session, signal: AbortSignal): Promise<void> {
    const bounded = <T>(work: Promise<T>): Promise<T | typeof ABORTED> => race(work, signal)

    let text = ''
    let problem = ''
    if (session.live && !session.liveFailed) {
      const live = await bounded(session.transcriber.finish(this.deps.finalWaitMs ?? 2500).catch(() => null))
      if (live === ABORTED || this.session !== session) return
      // A live session that heard nothing while the recording is plainly speech has failed quietly.
      if (live === null || (live.trim() === '' && session.loud)) session.liveFailed = true
      else text = live
    } else {
      // Never connected (or still connecting): the recording itself is the transcript's source.
      session.liveFailed = true
      session.transcriber.close()
    }
    if (session.liveFailed && session.bytes > 0) {
      const heardLive = session.transcriber.text()
      const onUpdate = (said: string, guess: string): void => {
        if (this.session !== session || this.state !== 'finishing') return
        session.text = said
        session.interim = guess
        session.rec?.words(said, guess)
        this.show('finishing')
      }
      const whole = await bounded(
        this.deps.batch(Buffer.concat(session.chunks), signal, onUpdate).catch((error: unknown): BatchResult => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not transcribe that.',
        })),
      )
      if (whole === ABORTED || this.session !== session) return
      if (whole.ok) text = whole.text
      else if (heardLive.trim() !== '') text = heardLive
      else problem = whole.error
    }
    text = text.trim()

    if (text === '') {
      if (problem !== '') {
        this.fail(session, problem)
        return
      }
      void session.rec?.final('')
      this.end(session)
      this.flash('notice', 'Nothing was heard. Try again a little closer to the microphone.', 3000)
      return
    }

    if (this.deps.fixNames !== undefined) {
      const fixed = await bounded(this.deps.fixNames(text).catch(() => text))
      if (fixed === ABORTED || this.session !== session) return
      text = fixed.trim() || text
    }

    let note = ''
    if (session.clean) {
      this.state = 'cleaning'
      session.text = text
      session.interim = ''
      this.show('cleaning')
      const cleaned = await bounded(this.deps.cleanUp(text).catch(() => null))
      if (cleaned === ABORTED || this.session !== session) return
      if (cleaned === null) note = 'Could not clean up, so it was typed as said.'
      else text = cleaned.trim() || text
    }

    this.state = 'typing'
    // The words are kept with the recording before they are typed.
    void session.rec?.final(text)
    // Typing is not cancelled half way; Esc after this point is too late.
    let outcome: TypeOutcome | 'inserted' = 'copied'
    try {
      outcome = await this.deps.type(text)
    } catch {
      outcome = 'copied'
    }
    if (this.session !== session) return
    this.log('Dictation typed', { outcome, characters: text.length, clean: session.clean, ms: this.now() - session.phaseSince })
    this.end(session)
    if (outcome === 'copied') {
      this.flash('notice', `Copied. Press ${this.pasteKeys()} to paste it.`, 5000)
    } else {
      this.flash('done', note === '' ? (session.clean ? 'Cleaned up and typed' : 'Typed') : note, note === '' ? 1200 : 3500)
    }
  }

  /** The words could not be had: keep the recording, say why, offer Retry. */
  private fail(session: Session, problem: string): void {
    this.log('Dictation failed, recording kept', { bytes: session.bytes })
    this.keep(session)
    void session.rec?.failed(problem)
    session.abort?.abort(new Error('failed'))
    this.end(session)
    const reason = problem.trim().replace(/\s*Nothing was typed\.?$/, '')
    this.flash('error', `${reason}${/[.!?]$/.test(reason) ? '' : '.'} Nothing was typed.`, RETRY_SHOW_MS, true)
  }

  private keep(session: Session): void {
    if (session.bytes === 0) return
    this.kept = { chunks: session.chunks, bytes: session.bytes, clean: session.clean, surface: this.surface, rec: session.rec }
  }

  private dismiss(): void {
    this.clearHide()
    this.releaseDismiss()
    this.view({ ...this.lastView, phase: 'hidden', canRetry: false })
    this.deps.pill.hide()
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
    // The rest of the audio goes to disk and is stitched into one file (the first stop wins).
    void session.rec?.stop()
  }

  private end(session: Session): void {
    this.stopListening(session)
    session.transcriber.close()
    this.finishSession(session)
  }

  private finishSession(session: Session): void {
    session.escape?.()
    session.escape = null
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
    } else if (phase === 'finishing' || phase === 'cleaning') {
      message = 'Esc to cancel'
    }
    this.view({
      phase,
      clean: session?.clean ?? false,
      text: session?.text ?? '',
      interim: session?.interim ?? '',
      message,
      switchKeys,
      ...(session === null ? {} : { since: session.phaseSince }),
      ...(session !== null && (phase === 'finishing' || phase === 'cleaning') ? { limitMs: session.limitMs } : {}),
    })
  }

  private flash(phase: 'done' | 'notice' | 'error', message: string, ms: number, retry = false): void {
    const canRetry = retry && this.kept !== null
    this.view({ phase, clean: false, text: '', interim: '', message, switchKeys: '', ...(canRetry ? { canRetry: true } : {}) })
    this.showPill()
    this.clearHide()
    this.releaseDismiss()
    if (canRetry) this.dismissRelease = this.deps.hold('Escape', () => this.cancel())
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      if (this.state !== 'idle') return
      this.releaseDismiss()
      this.view({ ...this.lastView, phase: 'hidden', canRetry: false })
      this.deps.pill.hide()
    }, ms)
  }

  /** The only way the pill is shown: never for a dictation into one of the app's own windows. */
  private showPill(): void {
    if (this.surface === 'pill') this.deps.pill.show()
  }

  private clearHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer)
    this.hideTimer = null
  }

  private releaseDismiss(): void {
    this.dismissRelease?.()
    this.dismissRelease = null
  }

  private view(view: DictationView): void {
    this.lastView = view
    this.deps.pill.view(view)
  }

  private log(message: string, fields?: Record<string, string | number | boolean>): void {
    this.deps.log?.(message, fields)
  }
}

/** The work, or ABORTED as soon as `signal` aborts, whichever is first. The work is left to end on its own. */
function race<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve(ABORTED)
      },
    )
  })
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
