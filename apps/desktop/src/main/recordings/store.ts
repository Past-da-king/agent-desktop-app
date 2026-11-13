/**
 * Recordings and dictations are never lost (26 Oct 2026): an update install restarted the app while the person was
 * in the middle of a recording, and it was gone.
 *
 * Every microphone path writes here while it records:
 *   <root>/<yyyy-mm-dd>/<id>/manifest.json     status recording / finished / recovered, source, chat, times
 *                            chunks/000001.pcm  16 kHz mono PCM16, one file about every second while recording
 *                            transcript.json    the words so far, flushed as they arrive (text, segments, state)
 *                            transcript.txt     the same words as plain text
 *                            audio.wav          the chunks stitched into one playable file when it ends
 * Every file is written to a temp name, synced and renamed into place, so a crash leaves the last whole version.
 *
 * After a crash or a restart, `recover` finds what was still recording (or never got its words), stitches the
 * chunks, finishes the transcript from the saved audio in the background (bounded), marks it recovered and says so
 * once. Running it again does nothing more. `cleanup` deletes audio from before today (the default; a setting) and
 * keeps transcripts and manifests; audio whose words were never had is kept until they are.
 */
import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

export const SAMPLE_RATE = 16_000
export const BYTES_PER_SECOND = SAMPLE_RATE * 2

export type RecordingSource = 'mic' | 'shortcut' | 'linked' | 'call' | 'phone'
export type RecordingStatus = 'recording' | 'finished' | 'recovered'
/** live: words arriving; complete: the final words; partial: some words, the rest could not be had; failed: none. */
export type TranscriptState = 'none' | 'live' | 'complete' | 'partial' | 'failed'
/** today: audio until the end of the day it was made; week: seven days; always: never deleted. */
export type AudioKeep = 'today' | 'week' | 'always'
export type DeliveryState = 'pending' | 'confirmed' | 'dismissed'

export const SOURCE_LABELS: Readonly<Record<RecordingSource, string>> = {
  mic: 'message box microphone',
  shortcut: 'dictation shortcut',
  linked: 'microphone on a linked device',
  call: 'voice call',
  phone: 'phone',
}

export interface RecordingManifest {
  v: 1
  id: string
  status: RecordingStatus
  source: RecordingSource
  /** The chat it was for, when it was for one. */
  chat: string | null
  /** Where the words were going: this app, or another app (the shortcut). */
  target: string
  startedAt: number
  updatedAt: number
  endedAt?: number
  recoveredAt?: number
  /** done, cancelled, failed (no words), crashed (the app ended while it recorded), abandoned (the sender went away). */
  ended?: 'done' | 'cancelled' | 'failed' | 'crashed' | 'abandoned'
  bytes: number
  chunks: number
  durationMs: number
  audio: 'chunks' | 'wav' | 'deleted' | 'none'
  audioDeletedAt?: number
  transcript: TranscriptState
  transcriptError?: string
  /** How many times the words were asked for again from the saved audio. */
  transcribeTries?: number
  /** The quiet notice about a recovered recording went out. */
  noticed?: boolean
  /**
   * For a dictation into this app's message box: pending until the window confirmed the words are in the draft.
   * A finished one still pending is offered back by the box, also after a restart. Left out: not that kind.
   */
  delivery?: DeliveryState
}

export interface TranscriptFile {
  text: string
  interim: string
  /** What the live words said before the saved audio was transcribed again, when that replaced them. */
  liveText?: string
  /** When each piece of settled text arrived, in ms from the start. */
  segments: Array<{ at: number; text: string; replaced?: boolean }>
  state: TranscriptState
  updatedAt: number
}

export interface RecordingHandle {
  readonly id: string
  readonly dir: string
  /** One chunk of 16 kHz mono PCM16. */
  audio(pcm: Buffer): void
  /** The words so far (settled) and the guess still forming. */
  words(text: string, interim?: string): void
  /** The microphone stopped: the rest of the audio is written and stitched into audio.wav. First call wins. */
  stop(ended?: RecordingManifest['ended']): Promise<void>
  /** The final words. */
  final(text: string): Promise<void>
  /** The words could not be had (the audio is kept). `cancelled`: he stopped it, so it is not offered back. */
  failed(error: string, cancelled?: boolean): Promise<void>
  /** The window confirmed the words are in the box, or it was put away. */
  delivered(state: Exclude<DeliveryState, 'pending'>): Promise<void>
  /** Every write so far is on disk. */
  flushed(): Promise<void>
}

export type Transcribe = (pcm: Buffer, signal: AbortSignal) => Promise<{ ok: true; text: string } | { ok: false; error: string }>

export interface RecoveredNotice {
  id: string
  chat: string | null
  startedAt: number
  durationMs: number
  source: RecordingSource
  text: string
  transcript: TranscriptState
  audioPath: string | null
}

export interface RecordingsOptions {
  root: string
  now?: () => number
  log?: (message: string, fields?: Record<string, string | number | boolean>) => void
  /** How often audio is written while recording. Default 1 s. */
  flushMs?: number
  /** A recording whose sender stopped sending this long ago (a linked device went away) is ended. Default 2 min. */
  idleMs?: number
}

/** What a linked phone tells about one dictation (RPC recordings.fromDevice). */
export interface PhoneDictationNote {
  /** The phone's own name for it: yyyymmdd-hhmmss. */
  stamp: string
  deviceId: string
  deviceName: string
  startedAt: number
  durationMs: number
  text: string
  /** done, kept (some words missing), interrupted (the app ended while it recorded), cancelled. */
  state: string
  chat: string | null
}

/** A note off the wire, checked. Null: not a note. */
export function phoneDictationNote(raw: unknown, deviceId: string, deviceName: string): PhoneDictationNote | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const stamp = typeof r['id'] === 'string' && /^\d{8}-\d{6}$/.test(r['id']) ? r['id'] : null
  const startedAt = typeof r['startedAt'] === 'number' && Number.isFinite(r['startedAt']) && r['startedAt'] > 0 ? r['startedAt'] : null
  const durationMs = typeof r['durationMs'] === 'number' && Number.isFinite(r['durationMs']) && r['durationMs'] >= 0 ? r['durationMs'] : null
  if (stamp === null || startedAt === null || durationMs === null || typeof r['text'] !== 'string' || r['text'].length > 200_000) return null
  const state = typeof r['state'] === 'string' && ['done', 'kept', 'interrupted', 'cancelled'].includes(r['state']) ? r['state'] : 'kept'
  const chat = typeof r['chat'] === 'string' && /^[\w:-]{1,100}$/.test(r['chat']) ? r['chat'] : null
  return { stamp, deviceId, deviceName, startedAt, durationMs, text: r['text'], state, chat }
}

export interface RecordingSummary {
  id: string
  /** Local time it started, "yyyy-mm-dd HH:mm". */
  time: string
  startedAt: number
  durationSeconds: number
  source: string
  /** finished, recovered, unfinished (the app ended and it was not recovered yet) or recording (now). */
  status: 'finished' | 'recovered' | 'unfinished' | 'recording'
  chat: string | null
  target: string
  audioExists: boolean
  audioPath: string | null
  transcriptState: TranscriptState
  transcriptPath: string
  preview: string
  transcriptChars: number
}

export interface RecordingDetail extends RecordingSummary {
  transcript: string
  liveTranscript?: string
  transcriptError?: string
  folder: string
}

/** Where the pieces of phone dictations are kept (beside the day folders, which only hold recordings made here). */
export const PHONE_AUDIO_DIR = 'phone-audio'

const ID_PATTERN = /^(\d{4})(\d{2})(\d{2})-\d{6}-[0-9a-f]{4,8}$/
const CHUNK_PATTERN = /^(\d{6})\.pcm$/
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
/** A batch transcription takes at most this much audio per call; longer recordings go in pieces. */
const PIECE_BYTES = BYTES_PER_SECOND * 60 * 4
const MAX_TRIES = 3
/** How far back a dictation that never reached its box is still offered back; it stays in Recordings for good. */
const UNDELIVERED_DAYS = 30

/** Local calendar day of `ms`, yyyy-mm-dd. */
export function dayKey(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

function localTime(ms: number): string {
  const date = new Date(ms)
  return `${dayKey(ms)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A 44-byte WAV header for 16 kHz mono PCM16 (the plain form every player reads). */
export function wavHeader(bytes: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + bytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(BYTES_PER_SECOND, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(bytes, 40)
  return header
}

/** Write to a temp file, sync it, then rename it into place: a crash leaves the old file or the new one, whole. */
export async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  const temp = `${path}.${randomBytes(3).toString('hex')}.tmp`
  const handle = await fsp.open(temp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsp.rename(temp, path)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.stat(path)
    return true
  } catch {
    return false
  }
}

function emptyTranscript(now: number): TranscriptFile {
  return { text: '', interim: '', segments: [], state: 'none', updatedAt: now }
}

export class Recordings {
  readonly root: string
  private readonly now: () => number
  private readonly log: NonNullable<RecordingsOptions['log']>
  private readonly flushMs: number
  private readonly idleMs: number
  private readonly live = new Map<string, Recorder>()

  constructor(options: RecordingsOptions) {
    this.root = options.root
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => undefined)
    this.flushMs = options.flushMs ?? 1000
    this.idleMs = options.idleMs ?? 120_000
  }

  /** Starts a recording on disk. Never throws: a recording that cannot be written still lets the microphone work. */
  begin(info: { source: RecordingSource; chat?: string | null; target?: string; delivery?: 'pending' }): RecordingHandle {
    const startedAt = this.now()
    const date = new Date(startedAt)
    const id = `${dayKey(startedAt).replace(/-/g, '')}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${randomBytes(2).toString('hex')}`
    const dir = join(this.root, dayKey(startedAt), id)
    const manifest: RecordingManifest = {
      v: 1,
      id,
      status: 'recording',
      source: info.source,
      chat: info.chat ?? null,
      target: info.target ?? 'this app',
      startedAt,
      updatedAt: startedAt,
      bytes: 0,
      chunks: 0,
      durationMs: 0,
      audio: 'chunks',
      transcript: 'none',
      ...(info.delivery === undefined ? {} : { delivery: info.delivery }),
    }
    const recorder = new Recorder({ dir, manifest, now: this.now, log: this.log, flushMs: this.flushMs, idleMs: this.idleMs, done: () => this.live.delete(id) })
    this.live.set(id, recorder)
    this.log('Recording started', { id, source: info.source })
    return recorder
  }

  /** A recording still open in this process, by id (a linked device sends its chunks by id). */
  open(id: string): RecordingHandle | null {
    return this.live.get(id) ?? null
  }

  /** Ids recording right now in this process. Recovery never touches them. */
  activeIds(): string[] {
    return [...this.live.keys()]
  }

  /** Every recording folder, newest day first. */
  private async folders(): Promise<Array<{ day: string; id: string; dir: string }>> {
    let days: string[]
    try {
      days = (await fsp.readdir(this.root)).filter((name) => DAY_PATTERN.test(name))
    } catch {
      return []
    }
    days.sort().reverse()
    const out: Array<{ day: string; id: string; dir: string }> = []
    for (const day of days) {
      let ids: string[]
      try {
        ids = (await fsp.readdir(join(this.root, day))).filter((name) => ID_PATTERN.test(name))
      } catch {
        continue
      }
      ids.sort().reverse()
      for (const id of ids) out.push({ day, id, dir: join(this.root, day, id) })
    }
    return out
  }

  /**
   * A dictation made on a linked phone: its words and times, sent again whenever its words change. The audio stays on
   * the phone. Never leaves fewer words than it already holds. Returns the recording's id here.
   */
  async fromDevice(note: PhoneDictationNote): Promise<string> {
    const id = `${note.stamp}-${createHash('sha1').update(note.deviceId).digest('hex').slice(0, 4)}`
    const dir = this.dirOf(id)
    if (dir === null) throw new Error('recording id')
    const now = this.now()
    const before = await readJson<TranscriptFile>(join(dir, 'transcript.json'))
    const text = before !== null && before.text.length > note.text.length ? before.text : note.text
    const transcript: TranscriptState = note.state === 'done' ? 'complete' : 'partial'
    const manifest: RecordingManifest = {
      v: 1,
      id,
      status: 'finished',
      source: 'phone',
      chat: note.chat,
      target: note.deviceName,
      startedAt: note.startedAt,
      updatedAt: now,
      endedAt: note.startedAt + note.durationMs,
      ended: note.state === 'interrupted' ? 'crashed' : note.state === 'cancelled' ? 'cancelled' : 'done',
      bytes: Math.round((note.durationMs / 1000) * BYTES_PER_SECOND),
      chunks: 0,
      durationMs: note.durationMs,
      audio: 'none',
      transcript,
    }
    const file: TranscriptFile = { text, interim: '', segments: [], state: transcript, updatedAt: now }
    await fsp.mkdir(dir, { recursive: true })
    await writeAtomic(join(dir, 'transcript.json'), JSON.stringify(file))
    await writeAtomic(join(dir, 'transcript.txt'), text)
    await writeAtomic(join(dir, 'manifest.json'), JSON.stringify(manifest))
    return id
  }

  /**
   * The audio of a phone dictation, kept like the audio of a recording made here (12 Nov 2026). The phone sends each
   * piece of a take to be written down (voice.transcribe) and its recording row only carries the words, so a take whose
   * words came back wrong could never be replayed. Each piece is saved as a playable wav under
   * `<root>/phone-audio/<yyyy-mm-dd>/<hhmmss-mmm>-<rand>.wav` and goes with the keep setting (cleanup). Never throws:
   * a piece that cannot be saved must not stop its words coming back. Returns the file name, or null.
   */
  async keepPhoneAudio(pcm: Buffer): Promise<string | null> {
    try {
      if (pcm.length === 0) return null
      const at = this.now()
      const date = new Date(at)
      const dir = join(this.root, PHONE_AUDIO_DIR, dayKey(at))
      await fsp.mkdir(dir, { recursive: true })
      const name = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}-${randomBytes(2).toString('hex')}.wav`
      const even = pcm.length % 2 === 0 ? pcm : pcm.subarray(0, pcm.length - 1)
      await writeAtomic(join(dir, name), Buffer.concat([wavHeader(even.length), even]))
      return name
    } catch (error) {
      this.log('Phone audio not kept', { reason: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /** Phone audio from before the keep setting's cutoff goes (day folders, oldest first). */
  private async cleanPhoneAudio(keep: AudioKeep): Promise<number> {
    if (keep === 'always') return 0
    const cutoff = keep === 'week' ? dayKey(this.now() - 7 * 86_400_000) : dayKey(this.now())
    const base = join(this.root, PHONE_AUDIO_DIR)
    let removed = 0
    let days: string[] = []
    try {
      days = (await fsp.readdir(base)).filter((name) => DAY_PATTERN.test(name))
    } catch {
      return 0
    }
    for (const day of days) {
      if (day >= cutoff) continue
      await fsp.rm(join(base, day), { recursive: true, force: true })
      removed += 1
    }
    return removed
  }

  private dirOf(id: string): string | null {
    const match = ID_PATTERN.exec(id)
    if (match === null) return null
    return join(this.root, `${match[1]}-${match[2]}-${match[3]}`, id)
  }

  // ---- after a restart ---------------------------------------------------------------------------------------

  /**
   * Finds what the last run left unfinished and finalises it: chunks stitched into audio.wav, the manifest marked
   * recovered, then (in the returned `words` promise) the transcript finished from the saved audio and one notice.
   * The first part is quick; nothing here should be awaited at startup.
   */
  async recover(options: {
    transcribe?: Transcribe
    timeoutMs?: (bytes: number) => number
    notify?: (notice: RecoveredNotice) => Promise<void>
  } = {}): Promise<{ recovered: string[]; words: Promise<void> }> {
    const active = new Set(this.activeIds())
    const recovered: string[] = []
    const needWords: string[] = []
    for (const folder of await this.folders()) {
      if (active.has(folder.id)) continue
      const manifestPath = join(folder.dir, 'manifest.json')
      const manifest = await readJson<RecordingManifest>(manifestPath)
      if (manifest === null) continue
      const transcript = (await readJson<TranscriptFile>(join(folder.dir, 'transcript.json'))) ?? emptyTranscript(this.now())
      // Still marked recording: the app ended while it recorded. Finished but the words never settled (the app
      // ended while it was transcribing): the same, it gets its words from the saved audio and a notice.
      const crashed = manifest.status === 'recording'
      const unsettled = manifest.status === 'finished' && transcript.state === 'live'
      if (crashed || unsettled) {
        try {
          const stitched = crashed ? await stitch(folder.dir) : { bytes: manifest.bytes, chunks: manifest.chunks, wav: await exists(join(folder.dir, 'audio.wav')) }
          if (stitched.bytes === 0 && transcript.text.trim() === '') {
            // Nothing was recorded and nothing heard: nothing to keep.
            await fsp.rm(folder.dir, { recursive: true, force: true })
            this.log('Recording was empty, removed', { id: folder.id })
            continue
          }
          const next: RecordingManifest = {
            ...manifest,
            status: 'recovered',
            recoveredAt: this.now(),
            updatedAt: this.now(),
            endedAt: manifest.endedAt ?? manifest.updatedAt,
            ended: crashed ? 'crashed' : (manifest.ended ?? 'crashed'),
            bytes: stitched.bytes,
            chunks: stitched.chunks,
            durationMs: Math.round((stitched.bytes / BYTES_PER_SECOND) * 1000),
            audio: stitched.wav ? 'wav' : 'none',
            transcript: transcript.text.trim() === '' ? 'none' : 'partial',
            noticed: false,
          }
          if (transcript.state === 'live') await writeTranscript(folder.dir, { ...transcript, interim: '', state: next.transcript, updatedAt: this.now() })
          await writeAtomic(manifestPath, JSON.stringify(next, null, 1))
          if (crashed) await fsp.rm(join(folder.dir, 'chunks'), { recursive: true, force: true })
          recovered.push(folder.id)
          this.log('Recording recovered', { id: folder.id, bytes: stitched.bytes })
        } catch (error) {
          this.log('Recording could not be recovered', { id: folder.id, reason: error instanceof Error ? error.message : 'unknown' })
          continue
        }
      }
      needWords.push(folder.id)
    }
    const words = (async () => {
      for (const id of needWords) {
        try {
          await this.settle(id, options)
        } catch (error) {
          this.log('Recording words could not be finished', { id, reason: error instanceof Error ? error.message : 'unknown' })
        }
      }
    })()
    return { recovered, words }
  }

  /**
   * A recording that has audio but not its final words gets them from the saved audio (bounded, at most three
   * tries over its life); a recovered one then gets its one notice. Does nothing for one that has both.
   */
  async settle(id: string, options: { transcribe?: Transcribe; timeoutMs?: (bytes: number) => number; notify?: (notice: RecoveredNotice) => Promise<void> }): Promise<void> {
    const dir = this.dirOf(id)
    if (dir === null || this.live.has(id)) return
    const manifestPath = join(dir, 'manifest.json')
    let manifest = await readJson<RecordingManifest>(manifestPath)
    if (manifest === null || manifest.status === 'recording') return
    let transcript = (await readJson<TranscriptFile>(join(dir, 'transcript.json'))) ?? emptyTranscript(this.now())
    const wav = join(dir, 'audio.wav')
    const wantsWords = manifest.transcript !== 'complete' && manifest.audio === 'wav' && (manifest.transcribeTries ?? 0) < MAX_TRIES && manifest.bytes > 0
    if (wantsWords && options.transcribe !== undefined) {
      manifest = { ...manifest, transcribeTries: (manifest.transcribeTries ?? 0) + 1, updatedAt: this.now() }
      await writeAtomic(manifestPath, JSON.stringify(manifest, null, 1))
      const pcm = (await fsp.readFile(wav)).subarray(44)
      const pieces: string[] = []
      let error = ''
      for (let offset = 0; offset < pcm.length; offset += PIECE_BYTES) {
        const piece = pcm.subarray(offset, Math.min(pcm.length, offset + PIECE_BYTES))
        const limit = options.timeoutMs?.(piece.length) ?? Math.min(90_000, 30_000 + (piece.length / BYTES_PER_SECOND) * 500)
        const signal = AbortSignal.timeout(limit)
        let result: Awaited<ReturnType<Transcribe>>
        try {
          result = await Promise.race([
            options.transcribe(piece, signal),
            new Promise<{ ok: false; error: string }>((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, error: `No words within ${Math.round(limit / 1000)} seconds.` }), { once: true })),
          ])
        } catch (caught) {
          result = { ok: false, error: caught instanceof Error ? caught.message : 'Could not transcribe that.' }
        }
        if (!result.ok) {
          error = result.error
          break
        }
        if (result.text.trim() !== '') pieces.push(result.text.trim())
      }
      if (error === '') {
        const text = pieces.join(' ')
        transcript = {
          ...transcript,
          ...(transcript.text.trim() !== '' && transcript.text.trim() !== text ? { liveText: transcript.text } : {}),
          text,
          interim: '',
          segments: [...transcript.segments, { at: manifest.durationMs, text, replaced: true }],
          state: 'complete',
          updatedAt: this.now(),
        }
        manifest = { ...manifest, transcript: 'complete', updatedAt: this.now() }
        delete manifest.transcriptError
        this.log('Recording words finished from the saved audio', { id, characters: text.length })
      } else {
        transcript = { ...transcript, interim: '', state: transcript.text.trim() === '' ? 'failed' : 'partial', updatedAt: this.now() }
        manifest = { ...manifest, transcript: transcript.state, transcriptError: error, updatedAt: this.now() }
        this.log('Recording words could not be had', { id, reason: error })
      }
      await writeTranscript(dir, transcript)
      await writeAtomic(manifestPath, JSON.stringify(manifest, null, 1))
    }
    if (manifest.status === 'recovered' && manifest.noticed !== true && options.notify !== undefined) {
      await options.notify({
        id,
        chat: manifest.chat,
        startedAt: manifest.startedAt,
        durationMs: manifest.durationMs,
        source: manifest.source,
        text: transcript.text,
        transcript: manifest.transcript,
        audioPath: manifest.audio === 'wav' ? wav : null,
      })
      manifest = { ...manifest, noticed: true, updatedAt: this.now() }
      await writeAtomic(manifestPath, JSON.stringify(manifest, null, 1))
    }
  }

  // ---- words that never reached the message box --------------------------------------------------------------

  /**
   * Finished dictations whose words the window never confirmed, newest first: what the message box offers back.
   * One still on its way (recording, or waiting for its words) is not listed, nor one he cancelled, nor one with no
   * words (yet: upkeep may still get them from the audio).
   */
  async undelivered(withinDays = UNDELIVERED_DAYS): Promise<Array<{ id: string; chat: string | null; text: string; startedAt: number; durationMs: number }>> {
    const oldest = dayKey(this.now() - withinDays * 86_400_000)
    const out: Array<{ id: string; chat: string | null; text: string; startedAt: number; durationMs: number }> = []
    for (const folder of await this.folders()) {
      if (folder.day < oldest) break
      if (this.live.has(folder.id)) continue
      const manifest = await readJson<RecordingManifest>(join(folder.dir, 'manifest.json'))
      if (manifest === null || manifest.delivery !== 'pending' || manifest.status === 'recording' || manifest.ended === 'cancelled') continue
      const transcript = await readJson<TranscriptFile>(join(folder.dir, 'transcript.json'))
      const text = (transcript?.text ?? '').trim()
      if (text === '') continue
      out.push({ id: folder.id, chat: manifest.chat, text, startedAt: manifest.startedAt, durationMs: manifest.durationMs })
    }
    return out
  }

  /** Marks a recording's words as in a box, or put away. A recording that is gone needs nothing. */
  async setDelivery(id: string, state: Exclude<DeliveryState, 'pending'>): Promise<void> {
    const open = this.live.get(id)
    if (open !== undefined) return open.delivered(state)
    const dir = this.dirOf(id)
    if (dir === null) return
    const path = join(dir, 'manifest.json')
    const manifest = await readJson<RecordingManifest>(path)
    if (manifest === null || manifest.delivery === state) return
    await writeAtomic(path, JSON.stringify({ ...manifest, delivery: state, updatedAt: this.now() }, null, 1))
  }

  // ---- retention ---------------------------------------------------------------------------------------------

  /**
   * Deletes audio the setting no longer keeps (by default anything from before today, local time). Transcripts and
   * manifests stay. Audio whose words were never had is kept, so nothing is lost when transcription fails.
   */
  async cleanup(keep: AudioKeep): Promise<{ deleted: string[]; kept: string[] }> {
    const deleted: string[] = []
    const kept: string[] = []
    if (keep === 'always') return { deleted, kept }
    const today = dayKey(this.now())
    const cutoff = keep === 'week' ? dayKey(this.now() - 7 * 86_400_000) : today
    const active = new Set(this.activeIds())
    for (const folder of await this.folders()) {
      if (folder.day >= cutoff || active.has(folder.id)) continue
      const manifestPath = join(folder.dir, 'manifest.json')
      const manifest = await readJson<RecordingManifest>(manifestPath)
      if (manifest === null || manifest.status === 'recording' || manifest.audio === 'deleted' || manifest.audio === 'none') continue
      if (manifest.transcript !== 'complete') {
        kept.push(folder.id)
        continue
      }
      await fsp.rm(join(folder.dir, 'audio.wav'), { force: true })
      await fsp.rm(join(folder.dir, 'chunks'), { recursive: true, force: true })
      await writeAtomic(manifestPath, JSON.stringify({ ...manifest, audio: 'deleted', audioDeletedAt: this.now(), updatedAt: this.now() }, null, 1))
      deleted.push(folder.id)
    }
    if (deleted.length > 0) this.log('Recording audio deleted by the keep setting', { count: deleted.length, keep })
    const phoneDays = await this.cleanPhoneAudio(keep)
    if (phoneDays > 0) this.log('Phone audio deleted by the keep setting', { days: phoneDays, keep })
    return { deleted, kept }
  }

  // ---- reading -----------------------------------------------------------------------------------------------

  async list(query: { since?: number; query?: string; limit?: number } = {}): Promise<RecordingSummary[]> {
    const limit = Math.max(1, Math.min(100, query.limit ?? 10))
    const words = (query.query ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '')
    const out: RecordingSummary[] = []
    for (const folder of await this.folders()) {
      if (out.length >= limit) break
      const detail = await this.read(folder.id, folder.dir)
      if (detail === null) continue
      if (query.since !== undefined && detail.startedAt < query.since) continue
      if (words.length > 0) {
        const haystack = `${detail.transcript} ${detail.liveTranscript ?? ''} ${detail.source} ${detail.time}`.toLowerCase()
        if (!words.every((word) => haystack.includes(word))) continue
      }
      const { transcript: _t, liveTranscript: _l, transcriptError: _e, folder: _f, ...summary } = detail
      out.push(summary)
    }
    return out
  }

  async get(id: string): Promise<RecordingDetail | null> {
    const dir = this.dirOf(id.trim())
    return dir === null ? null : this.read(id.trim(), dir)
  }

  private async read(id: string, dir: string): Promise<RecordingDetail | null> {
    const manifest = await readJson<RecordingManifest>(join(dir, 'manifest.json'))
    if (manifest === null) return null
    const transcript = (await readJson<TranscriptFile>(join(dir, 'transcript.json'))) ?? emptyTranscript(manifest.updatedAt)
    const wav = join(dir, 'audio.wav')
    const hasWav = manifest.audio === 'wav' && (await exists(wav))
    const recordingNow = this.live.get(id)?.listening === true
    const hasChunks = manifest.audio === 'chunks' && (await exists(join(dir, 'chunks')))
    const status: RecordingSummary['status'] = recordingNow ? 'recording' : manifest.status === 'recording' ? 'unfinished' : manifest.status
    const bytes = manifest.bytes
    const text = transcript.text.trim()
    const words = text === '' && transcript.interim.trim() !== '' ? transcript.interim.trim() : text
    return {
      id,
      time: localTime(manifest.startedAt),
      startedAt: manifest.startedAt,
      durationSeconds: Math.round(bytes / BYTES_PER_SECOND),
      source: SOURCE_LABELS[manifest.source] ?? manifest.source,
      status,
      chat: manifest.chat,
      target: manifest.target,
      audioExists: hasWav || hasChunks,
      audioPath: hasWav ? wav : hasChunks ? join(dir, 'chunks') : null,
      transcriptState: recordingNow && manifest.transcript !== 'complete' ? 'live' : manifest.transcript,
      transcriptPath: join(dir, 'transcript.txt'),
      preview: words.length > 280 ? `${words.slice(0, 277)}...` : words,
      transcriptChars: words.length,
      transcript: words,
      ...(transcript.liveText === undefined ? {} : { liveTranscript: transcript.liveText }),
      ...(manifest.transcriptError === undefined ? {} : { transcriptError: manifest.transcriptError }),
      folder: dir,
    }
  }
}

/** The chunk files in order, joined, written as audio.wav. Leaves the chunks for the caller to remove. */
async function stitch(dir: string): Promise<{ bytes: number; chunks: number; wav: boolean }> {
  const chunkDir = join(dir, 'chunks')
  let names: string[] = []
  try {
    names = (await fsp.readdir(chunkDir)).filter((name) => CHUNK_PATTERN.test(name)).sort()
  } catch {
    names = []
  }
  const wavPath = join(dir, 'audio.wav')
  if (names.length === 0) {
    // Stitched already (the chunks went after the wav was written): keep that.
    if (await exists(wavPath)) {
      const size = (await fsp.stat(wavPath)).size
      return { bytes: Math.max(0, size - 44), chunks: 0, wav: true }
    }
    return { bytes: 0, chunks: 0, wav: false }
  }
  const parts: Buffer[] = []
  for (const name of names) parts.push(await fsp.readFile(join(chunkDir, name)))
  const pcm = Buffer.concat(parts)
  const even = pcm.subarray(0, pcm.length - (pcm.length % 2))
  await writeAtomic(wavPath, Buffer.concat([wavHeader(even.length), even]))
  return { bytes: even.length, chunks: names.length, wav: true }
}

async function writeTranscript(dir: string, transcript: TranscriptFile): Promise<void> {
  await writeAtomic(join(dir, 'transcript.json'), JSON.stringify(transcript, null, 1))
  await writeAtomic(join(dir, 'transcript.txt'), transcript.text)
}

/** One recording being written. All disk work runs in order on one queue; nothing here throws to the caller. */
class Recorder implements RecordingHandle {
  readonly id: string
  readonly dir: string
  private manifest: RecordingManifest
  private transcript: TranscriptFile
  private readonly now: () => number
  private readonly log: NonNullable<RecordingsOptions['log']>
  private readonly done: () => void
  private readonly idleMs: number
  private queue: Promise<void>
  private pending: Buffer[] = []
  private pendingBytes = 0
  private timer: ReturnType<typeof setInterval> | null
  private stopped: Promise<void> | null = null
  private transcriptQueued = false
  private lastAudio: number
  private broken = false

  constructor(input: {
    dir: string
    manifest: RecordingManifest
    now: () => number
    log: NonNullable<RecordingsOptions['log']>
    flushMs: number
    idleMs: number
    done: () => void
  }) {
    this.id = input.manifest.id
    this.dir = input.dir
    this.manifest = input.manifest
    this.now = input.now
    this.log = input.log
    this.done = input.done
    this.idleMs = input.idleMs
    this.lastAudio = input.now()
    this.transcript = emptyTranscript(input.now())
    this.queue = this.run(async () => {
      await fsp.mkdir(join(this.dir, 'chunks'), { recursive: true })
      await this.writeManifest()
    })
    this.timer = setInterval(() => this.tick(), input.flushMs)
    this.timer.unref?.()
  }

  audio(pcm: Buffer): void {
    if (this.stopped !== null || pcm.length === 0) return
    this.pending.push(Buffer.from(pcm))
    this.pendingBytes += pcm.length
    this.lastAudio = this.now()
    // A big burst (a linked device sends a second at a time) goes straight out.
    if (this.pendingBytes >= BYTES_PER_SECOND * 2) this.flushAudio()
  }

  words(text: string, interim = ''): void {
    if (this.manifest.transcript === 'complete') return
    const before = this.transcript.text
    if (text !== before) {
      const at = this.now() - this.manifest.startedAt
      if (text.startsWith(before)) this.transcript.segments.push({ at, text: text.slice(before.length) })
      else this.transcript.segments.push({ at, text, replaced: true })
    }
    this.transcript = { ...this.transcript, text, interim, state: 'live', updatedAt: this.now() }
    if (this.manifest.transcript !== 'live') {
      this.manifest = { ...this.manifest, transcript: 'live' }
    }
    this.queueTranscript()
  }

  stop(ended: RecordingManifest['ended'] = 'done'): Promise<void> {
    if (this.stopped !== null) return this.stopped
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.flushAudio()
    this.stopped = this.run(async () => {
      if (this.manifest.bytes === 0 && this.transcript.text.trim() === '') {
        // Nothing was recorded (the microphone never opened): leave nothing behind.
        await fsp.rm(this.dir, { recursive: true, force: true })
        this.log('Recording ended empty', { id: this.id })
        this.broken = true
        return
      }
      const stitched = await stitch(this.dir)
      this.manifest = {
        ...this.manifest,
        status: 'finished',
        ended,
        endedAt: this.now(),
        updatedAt: this.now(),
        bytes: stitched.bytes,
        durationMs: Math.round((stitched.bytes / BYTES_PER_SECOND) * 1000),
        audio: stitched.wav ? 'wav' : 'none',
      }
      await this.writeManifest()
      await fsp.rm(join(this.dir, 'chunks'), { recursive: true, force: true })
      this.log('Recording finished', { id: this.id, bytes: stitched.bytes, ended })
    })
    return this.stopped
  }

  async final(text: string): Promise<void> {
    if (this.stopped === null) await this.stop()
    this.transcript = {
      ...this.transcript,
      text,
      interim: '',
      segments: text === this.transcript.text ? this.transcript.segments : [...this.transcript.segments, { at: this.now() - this.manifest.startedAt, text, replaced: true }],
      state: 'complete',
      updatedAt: this.now(),
    }
    this.manifest = { ...this.manifest, transcript: 'complete', updatedAt: this.now(), ...(this.manifest.delivery === 'dismissed' ? { delivery: 'pending' as const } : {}) }
    delete this.manifest.transcriptError
    await this.run(async () => {
      await writeTranscript(this.dir, this.transcript)
      await this.writeManifest()
    })
    this.done()
  }

  async delivered(state: Exclude<DeliveryState, 'pending'>): Promise<void> {
    if (this.manifest.delivery === undefined) return
    this.manifest = { ...this.manifest, delivery: state, updatedAt: this.now() }
    await this.run(() => this.writeManifest())
  }

  async failed(error: string, cancelled = false): Promise<void> {
    if (this.stopped === null) await this.stop('failed')
    const state: TranscriptState = this.transcript.text.trim() === '' ? 'failed' : 'partial'
    this.transcript = { ...this.transcript, interim: '', state, updatedAt: this.now() }
    this.manifest = {
      ...this.manifest,
      transcript: state,
      transcriptError: error.slice(0, 300),
      updatedAt: this.now(),
      // Cancelled on purpose: not offered back. A Retry that finds the words makes it pending again.
      ...(cancelled && this.manifest.delivery !== undefined ? { delivery: 'dismissed' as const } : {}),
    }
    await this.run(async () => {
      await writeTranscript(this.dir, this.transcript)
      await this.writeManifest()
    })
    this.done()
  }

  /** Still taking audio (not stopped yet). */
  get listening(): boolean {
    return this.stopped === null
  }

  flushed(): Promise<void> {
    this.flushAudio()
    return this.queue
  }

  private tick(): void {
    this.flushAudio()
    if (this.now() - this.lastAudio > this.idleMs) {
      // Nothing came for a long time (a linked device closed its page): end it; the words come from the audio.
      this.log('Recording ended: nothing arrived', { id: this.id })
      void this.stop('abandoned').then(() => this.done())
    }
  }

  private flushAudio(): void {
    if (this.pendingBytes === 0) return
    const data = Buffer.concat(this.pending)
    this.pending = []
    this.pendingBytes = 0
    void this.run(async () => {
      const index = this.manifest.chunks + 1
      await writeAtomic(join(this.dir, 'chunks', `${pad(index, 6)}.pcm`), data)
      this.manifest = {
        ...this.manifest,
        chunks: index,
        bytes: this.manifest.bytes + data.length,
        durationMs: Math.round(((this.manifest.bytes + data.length) / BYTES_PER_SECOND) * 1000),
        updatedAt: this.now(),
      }
      await this.writeManifest()
    })
  }

  private queueTranscript(): void {
    if (this.transcriptQueued) return
    this.transcriptQueued = true
    void this.run(async () => {
      this.transcriptQueued = false
      await writeTranscript(this.dir, this.transcript)
    })
  }

  private async writeManifest(): Promise<void> {
    await writeAtomic(join(this.dir, 'manifest.json'), JSON.stringify(this.manifest, null, 1))
  }

  /** Runs disk work after everything before it; a failure is logged and never stops the microphone. */
  private run(work: () => Promise<void>): Promise<void> {
    const next = (this.queue ?? Promise.resolve()).then(async () => {
      if (this.broken) return
      try {
        await work()
      } catch (error) {
        this.log('Recording write failed', { id: this.id, reason: error instanceof Error ? error.message : 'unknown' })
      }
    })
    this.queue = next
    return next
  }
}
