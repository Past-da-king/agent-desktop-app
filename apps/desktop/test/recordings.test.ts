/**
 * His recordings and dictations are never lost (26 Oct 2026): written to disk as they happen, recovered after a
 * crash or a restart, old audio deleted by the keep setting, and found by the agent with recordings_list / _get.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SETTINGS, type DictationCommand } from '@agent/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DictationController, type DictationDeps, type TranscriberLike } from '../src/main/dictation/controller'
import { RPC_ALLOWED, RPC_CHANNELS } from '../src/shared/rpc-methods'
import { Recordings, dayKey, phoneDictationNote, type RecordingManifest, type RecoveredNotice, type TranscriptFile } from '../src/main/recordings/store'
import { recoveredNoticeText, startRecordingsUpkeep, untilNextNight } from '../src/main/recordings/upkeep'
import { buildSystemPrompt, RECORDINGS_LINE } from '../src/main/runtime/prompt'
import { READ_ONLY_TOOLS } from '../src/main/runtime/read-only'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { SettingsStore } from '../src/main/settings'
import { parseSince, recordingsTools } from '../src/main/tools/recordings'
import { VoiceService } from '../src/main/voice/service'

// Real disk writes with fsync: under a full parallel run they can take seconds, so the waits are generous.
vi.setConfig({ testTimeout: 30_000 })

const SECOND = 32_000

/** A second of loud 16 kHz PCM16, so the dictation hears speech. */
function speech(seconds = 1, value = 8000): Buffer {
  const pcm = Buffer.alloc(SECOND * seconds)
  for (let index = 0; index < pcm.length / 2; index += 1) pcm.writeInt16LE(index % 2 === 0 ? value : -value, index * 2)
  return pcm
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function chunkFiles(dir: string): string[] {
  const chunks = join(dir, 'chunks')
  return existsSync(chunks) ? readdirSync(chunks).filter((name) => name.endsWith('.pcm')) : []
}

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-recordings-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('written to disk while it records', () => {
  it('puts the audio in chunk files about every second, before the recording ends', async () => {
    const recordings = new Recordings({ root, flushMs: 40 })
    const rec = recordings.begin({ source: 'mic', chat: 'c1' })
    expect(rec.dir).toContain(join(root, dayKey(Date.now())))
    rec.audio(speech(1))
    await until(() => chunkFiles(rec.dir).length >= 1)
    rec.audio(speech(1))
    await until(() => chunkFiles(rec.dir).length >= 2)
    await rec.flushed()
    const manifest = json<RecordingManifest>(join(rec.dir, 'manifest.json'))
    expect(manifest.status).toBe('recording')
    expect(manifest.source).toBe('mic')
    expect(manifest.chat).toBe('c1')
    expect(manifest.bytes).toBe(2 * SECOND)
    expect(manifest.durationMs).toBe(2000)
    // Nothing is left half written: only whole chunk files and no temp files.
    expect(readdirSync(join(rec.dir, 'chunks')).every((name) => /^\d{6}\.pcm$/.test(name))).toBe(true)
    await rec.stop()
  })

  it('flushes the transcript as the words arrive, with when each piece came', async () => {
    const recordings = new Recordings({ root, flushMs: 40 })
    const rec = recordings.begin({ source: 'shortcut' })
    rec.words('Hello', 'the')
    await rec.flushed()
    expect(json<TranscriptFile>(join(rec.dir, 'transcript.json')).text).toBe('Hello')
    expect(readFileSync(join(rec.dir, 'transcript.txt'), 'utf8')).toBe('Hello')
    rec.words('Hello there', '')
    await rec.flushed()
    const transcript = json<TranscriptFile>(join(rec.dir, 'transcript.json'))
    expect(transcript.text).toBe('Hello there')
    expect(transcript.state).toBe('live')
    expect(transcript.segments.map((segment) => segment.text)).toEqual(['Hello', ' there'])
    await rec.final('Hello there.')
    expect(json<TranscriptFile>(join(rec.dir, 'transcript.json')).state).toBe('complete')
  })

  it('stitches the chunks into one playable WAV when it ends', async () => {
    const recordings = new Recordings({ root, flushMs: 40 })
    const rec = recordings.begin({ source: 'mic' })
    rec.audio(speech(1))
    rec.audio(speech(2))
    await rec.stop()
    const wav = readFileSync(join(rec.dir, 'audio.wav'))
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt32LE(40)).toBe(3 * SECOND)
    expect(wav.length).toBe(44 + 3 * SECOND)
    expect(existsSync(join(rec.dir, 'chunks'))).toBe(false)
    expect(json<RecordingManifest>(join(rec.dir, 'manifest.json'))).toMatchObject({ status: 'finished', audio: 'wav', ended: 'done', bytes: 3 * SECOND })
  })

  it('leaves nothing behind when the microphone never gave any audio', async () => {
    const recordings = new Recordings({ root, flushMs: 40 })
    const rec = recordings.begin({ source: 'mic' })
    await rec.stop()
    expect(existsSync(rec.dir)).toBe(false)
  })
})

// ---- the dictation engine, end to end with a fake live model ------------------------------------------------

class LiveFake implements TranscriberLike {
  settled = ''
  constructor(private readonly handlers: { onUpdate: (text: string, interim: string) => void }) {}
  start(): Promise<void> {
    return Promise.resolve()
  }
  audio(): void {}
  say(text: string): void {
    this.settled = text
    this.handlers.onUpdate(text, '')
  }
  async finish(): Promise<string> {
    return this.settled
  }
  flush(): void {}
  close(): void {}
  text(): string {
    return this.settled
  }
}

function dictation(recordings: Recordings, overrides: Partial<DictationDeps> = {}): { controller: DictationController; live: () => LiveFake; typed: string[]; commands: DictationCommand[] } {
  const fakes: LiveFake[] = []
  const typed: string[] = []
  const commands: DictationCommand[] = []
  const controller = new DictationController({
    hasKey: () => true,
    transcriber: (handlers) => {
      const fake = new LiveFake(handlers)
      fakes.push(fake)
      return fake
    },
    batch: async () => ({ ok: true, text: 'From the whole recording.' }),
    cleanUp: async (text) => text,
    type: async (text) => {
      typed.push(text)
      return 'inserted'
    },
    mask: () => undefined,
    pill: { show: () => undefined, hide: () => undefined, view: () => undefined, command: (command) => commands.push(command) },
    hold: () => () => undefined,
    keys: () => ({ dictate: 'Alt+Space', cleanSwitch: null }),
    format: (accelerator) => accelerator,
    surface: () => 'app',
    record: (surface) => recordings.begin({ source: 'mic', chat: 'c7', target: surface === 'app' ? 'this app' : 'another app' }),
    silenceMs: 60_000,
    nothingMs: 60_000,
    ...overrides,
  })
  return { controller, live: () => fakes[fakes.length - 1]!, typed, commands }
}

async function onlyRecordingDir(): Promise<string> {
  let found = ''
  await until(() => {
    const day = existsSync(root) ? readdirSync(root)[0] : undefined
    const id = day === undefined ? undefined : readdirSync(join(root, day))[0]
    if (day === undefined || id === undefined || !existsSync(join(root, day, id, 'manifest.json'))) return false
    found = join(root, day, id)
    return true
  })
  return found
}

describe('every dictation is written as it happens', () => {
  it('has its chunks and its words on disk while he is still talking, and the final words after', async () => {
    const recordings = new Recordings({ root, flushMs: 40 })
    const { controller, live, typed } = dictation(recordings)
    controller.toggle('plain')
    controller.micState(1, true, '')
    for (let index = 0; index < 4; index += 1) controller.audio(1, speech(1))
    live().say('Send the quote to')
    const dir = await onlyRecordingDir()
    await until(() => chunkFiles(dir).length >= 1 && existsSync(join(dir, 'transcript.json')))
    await until(() => json<TranscriptFile>(join(dir, 'transcript.json')).text === 'Send the quote to')
    expect(json<RecordingManifest>(join(dir, 'manifest.json'))).toMatchObject({ status: 'recording', source: 'mic', chat: 'c7', target: 'this app' })
    expect(controller.phase).toBe('listening')

    live().say('Send the quote to Roger today')
    controller.toggle('plain')
    await until(() => typed.length === 1)
    await until(() => json<RecordingManifest>(join(dir, 'manifest.json')).transcript === 'complete')
    expect(typed).toEqual(['Send the quote to Roger today'])
    expect(json<RecordingManifest>(join(dir, 'manifest.json'))).toMatchObject({ status: 'finished', audio: 'wav', bytes: 4 * SECOND })
    expect(readFileSync(join(dir, 'transcript.txt'), 'utf8')).toBe('Send the quote to Roger today')
  })

  it('keeps the audio and says the words failed when transcription fails (nothing is lost)', async () => {
    const recordings = new Recordings({ root, flushMs: 40 })
    const { controller } = dictation(recordings, {
      transcriber: () => ({
        start: () => Promise.reject(new Error('offline')),
        audio: () => undefined,
        finish: () => Promise.reject(new Error('offline')),
        flush: () => undefined,
        close: () => undefined,
        text: () => '',
      }),
      batch: async () => ({ ok: false, error: 'The service is down.' }),
    })
    controller.toggle('plain')
    controller.micState(1, true, '')
    controller.audio(1, speech(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.toggle('plain')
    const dir = await onlyRecordingDir()
    await until(() => existsSync(join(dir, 'manifest.json')) && json<RecordingManifest>(join(dir, 'manifest.json')).transcript === 'failed')
    const manifest = json<RecordingManifest>(join(dir, 'manifest.json'))
    expect(manifest).toMatchObject({ status: 'finished', audio: 'wav', bytes: 2 * SECOND, transcriptError: 'The service is down.' })
    expect(statSync(join(dir, 'audio.wav')).size).toBe(44 + 2 * SECOND)
    expect(controller.canRetry).toBe(true)
  })

  it('a cancelled dictation is still kept on disk', async () => {
    const recordings = new Recordings({ root, flushMs: 40 })
    const { controller, live, typed } = dictation(recordings)
    controller.toggle('plain')
    controller.micState(1, true, '')
    controller.audio(1, speech(1))
    live().say('Never mind')
    controller.cancel()
    const dir = await onlyRecordingDir()
    await until(() => existsSync(join(dir, 'manifest.json')) && json<RecordingManifest>(join(dir, 'manifest.json')).ended === 'cancelled' && json<RecordingManifest>(join(dir, 'manifest.json')).transcript === 'partial')
    expect(typed).toEqual([])
    expect(existsSync(join(dir, 'audio.wav'))).toBe(true)
    expect(readFileSync(join(dir, 'transcript.txt'), 'utf8')).toBe('Never mind')
  })
})

// ---- after a crash ------------------------------------------------------------------------------------------

/** A recording the app was making when it was killed: chunks and partial words on disk, never stopped. */
async function crashedRecording(chat: string | null = 'c9'): Promise<{ dir: string; id: string }> {
  const before = new Recordings({ root, flushMs: 40 })
  const rec = before.begin({ source: 'mic', chat })
  rec.audio(speech(2))
  rec.words('Remind me to call', 'the')
  await rec.flushed()
  rec.audio(speech(1))
  await rec.flushed()
  return { dir: rec.dir, id: rec.id }
}

describe('recovery after a crash or a restart', () => {
  it('stitches the chunks, finishes the words from the saved audio, marks it recovered and tells him once', async () => {
    const { dir, id } = await crashedRecording()
    expect(json<RecordingManifest>(join(dir, 'manifest.json')).status).toBe('recording')
    expect(chunkFiles(dir).length).toBe(2)

    const after = new Recordings({ root })
    const heard: number[] = []
    const notices: RecoveredNotice[] = []
    const { recovered, words } = await after.recover({
      transcribe: async (pcm) => {
        heard.push(pcm.length)
        return { ok: true, text: 'Remind me to call the plumber at four.' }
      },
      notify: async (notice) => {
        notices.push(notice)
      },
    })
    expect(recovered).toEqual([id])
    // The audio is whole and playable before the words come back.
    const wav = readFileSync(join(dir, 'audio.wav'))
    expect(wav.readUInt32LE(40)).toBe(3 * SECOND)
    expect(existsSync(join(dir, 'chunks'))).toBe(false)
    await words
    expect(heard).toEqual([3 * SECOND])
    const manifest = json<RecordingManifest>(join(dir, 'manifest.json'))
    expect(manifest).toMatchObject({ status: 'recovered', ended: 'crashed', audio: 'wav', transcript: 'complete', noticed: true, chat: 'c9' })
    const transcript = json<TranscriptFile>(join(dir, 'transcript.json'))
    expect(transcript.text).toBe('Remind me to call the plumber at four.')
    expect(transcript.liveText).toBe('Remind me to call')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ id, chat: 'c9', text: 'Remind me to call the plumber at four.', durationMs: 3000 })
    expect(recoveredNoticeText(notices[0]!)).toMatch(/^An unfinished recording from \d\d:\d\d \(0:03, message box microphone\) was saved after the app closed\. Its words: "Remind me to call the plumber at four\."$/)
  })

  it('does nothing more on a second restart', async () => {
    await crashedRecording()
    const first = await new Recordings({ root }).recover({ transcribe: async () => ({ ok: true, text: 'Done.' }), notify: async () => undefined })
    await first.words
    let asked = 0
    let told = 0
    const second = await new Recordings({ root }).recover({
      transcribe: async () => {
        asked += 1
        return { ok: true, text: 'Again.' }
      },
      notify: async () => {
        told += 1
      },
    })
    await second.words
    expect(second.recovered).toEqual([])
    expect(asked).toBe(0)
    expect(told).toBe(0)
  })

  it('keeps the audio and the partial words when transcription fails, and tries at most three times', async () => {
    const { dir } = await crashedRecording()
    let asked = 0
    const failing = async (): Promise<{ ok: false; error: string }> => {
      asked += 1
      return { ok: false, error: 'Quota exceeded.' }
    }
    const notices: RecoveredNotice[] = []
    const first = await new Recordings({ root }).recover({ transcribe: failing, notify: async (notice) => void notices.push(notice) })
    await first.words
    const manifest = json<RecordingManifest>(join(dir, 'manifest.json'))
    expect(manifest).toMatchObject({ status: 'recovered', transcript: 'partial', transcriptError: 'Quota exceeded.', transcribeTries: 1, audio: 'wav' })
    expect(readFileSync(join(dir, 'transcript.txt'), 'utf8')).toBe('Remind me to call')
    expect(notices).toHaveLength(1)
    expect(recoveredNoticeText(notices[0]!)).toContain('Its words: "Remind me to call"')
    for (let run = 0; run < 4; run += 1) await (await new Recordings({ root }).recover({ transcribe: failing })).words
    expect(asked).toBe(3)
    expect(existsSync(join(dir, 'audio.wav'))).toBe(true)
  })

  it('a hung transcription gives up at its limit and the recording stays', async () => {
    const { dir } = await crashedRecording()
    const { words } = await new Recordings({ root }).recover({ transcribe: () => new Promise(() => undefined), timeoutMs: () => 50 })
    await words
    expect(json<RecordingManifest>(join(dir, 'manifest.json'))).toMatchObject({ status: 'recovered', transcript: 'partial' })
    expect(json<RecordingManifest>(join(dir, 'manifest.json')).transcriptError).toMatch(/No words within/)
  })

  it('a dictation that stopped but never got its words (the app ended while transcribing) is recovered too', async () => {
    const before = new Recordings({ root, flushMs: 40 })
    const rec = before.begin({ source: 'shortcut' })
    rec.audio(speech(1))
    rec.words('Half of it')
    await rec.stop()
    const notices: RecoveredNotice[] = []
    const { recovered, words } = await new Recordings({ root }).recover({ transcribe: async () => ({ ok: true, text: 'Half of it and the rest.' }), notify: async (notice) => void notices.push(notice) })
    await words
    expect(recovered).toEqual([rec.id])
    expect(notices.map((notice) => notice.text)).toEqual(['Half of it and the rest.'])
  })

  it('never touches a recording that is still going in this run', async () => {
    const recordings = new Recordings({ root, flushMs: 40 })
    const rec = recordings.begin({ source: 'mic' })
    rec.audio(speech(1))
    await rec.flushed()
    const { recovered } = await recordings.recover({ transcribe: async () => ({ ok: true, text: 'x' }) })
    expect(recovered).toEqual([])
    expect(json<RecordingManifest>(join(rec.dir, 'manifest.json')).status).toBe('recording')
    await rec.stop()
  })

  it('the startup pass runs late, recovers, tells him and cleans up, without blocking', async () => {
    await crashedRecording()
    const notices: RecoveredNotice[] = []
    const upkeep = startRecordingsUpkeep({
      recordings: new Recordings({ root }),
      keep: () => 'today',
      transcribe: () => async () => ({ ok: true, text: 'Words.' }),
      notify: async (notice) => void notices.push(notice),
      delayMs: 10,
    })
    expect(notices).toHaveLength(0)
    await upkeep.done
    upkeep.stop()
    expect(notices.map((notice) => notice.text)).toEqual(['Words.'])
  })
})

// ---- retention ----------------------------------------------------------------------------------------------

describe('audio is kept until the end of its day, transcripts always', () => {
  const DAY = 86_400_000

  async function made(at: number, words = 'Kept words.', complete = true): Promise<string> {
    const recordings = new Recordings({ root, now: () => at, flushMs: 40 })
    const rec = recordings.begin({ source: 'mic' })
    rec.audio(speech(1))
    if (complete) await rec.final(words)
    else await rec.failed('No key.')
    return rec.dir
  }

  it("deletes yesterday's audio and keeps its transcript and manifest; today's audio stays", async () => {
    const now = new Date(2026, 9, 26, 15, 0).getTime()
    const yesterday = await made(now - DAY)
    const today = await made(now - 60_000)
    const { deleted } = await new Recordings({ root, now: () => now }).cleanup('today')
    expect(deleted).toHaveLength(1)
    expect(existsSync(join(yesterday, 'audio.wav'))).toBe(false)
    expect(readFileSync(join(yesterday, 'transcript.txt'), 'utf8')).toBe('Kept words.')
    expect(json<RecordingManifest>(join(yesterday, 'manifest.json'))).toMatchObject({ audio: 'deleted', transcript: 'complete' })
    expect(existsSync(join(today, 'audio.wav'))).toBe(true)
  })

  it('keeps audio whose words were never had, and follows the week and always settings', async () => {
    const now = new Date(2026, 9, 26, 15, 0).getTime()
    const unheard = await made(now - DAY, '', false)
    const twoDays = await made(now - 2 * DAY)
    const tenDays = await made(now - 10 * DAY)
    const store = new Recordings({ root, now: () => now })
    expect((await store.cleanup('always')).deleted).toEqual([])
    const week = await store.cleanup('week')
    expect(week.deleted).toHaveLength(1)
    expect(existsSync(join(tenDays, 'audio.wav'))).toBe(false)
    expect(existsSync(join(twoDays, 'audio.wav'))).toBe(true)
    const today = await store.cleanup('today')
    expect(existsSync(join(twoDays, 'audio.wav'))).toBe(false)
    expect(existsSync(join(unheard, 'audio.wav'))).toBe(true)
    expect(today.kept).toHaveLength(1)
  })

  it('the keep setting defaults to the end of the day and takes only known values', () => {
    expect(DEFAULT_SETTINGS.recordingAudioKeep).toBe('today')
    const settings = new SettingsStore(join(root, 'settings.json'), { hostname: () => 'pc' })
    expect(settings.get().recordingAudioKeep).toBe('today')
    settings.save({ recordingAudioKeep: 'nonsense' as never })
    expect(settings.get().recordingAudioKeep).toBe('today')
    settings.save({ recordingAudioKeep: 'week' })
    expect(settings.get().recordingAudioKeep).toBe('week')
  })

  it('the nightly pass is armed for just after the next local midnight', () => {
    const now = new Date(2026, 9, 26, 23, 0).getTime()
    expect(untilNextNight(now)).toBe(61 * 60_000)
  })
})

// ---- the agent finds them -----------------------------------------------------------------------------------

describe('recordings_list and recordings_get', () => {
  it('list the right recordings, newest first, filter by words and time, and give one transcript in full', async () => {
    const base = new Date(2026, 9, 26, 9, 0).getTime()
    const at = (minutes: number): Recordings => new Recordings({ root, now: () => base + minutes * 60_000, flushMs: 40 })
    const first = at(0).begin({ source: 'shortcut' })
    first.audio(speech(1))
    await first.final('Buy milk and bread.')
    const second = at(60).begin({ source: 'call' })
    second.audio(speech(2))
    await second.final('You: Book the venue for Friday.\nAgent: Done.')
    // The third one was cut off by a crash and recovered.
    const third = at(120).begin({ source: 'mic', chat: 'c3' })
    third.audio(speech(1))
    third.words('The recording I was making about the Durban trip')
    await third.flushed()
    await (await new Recordings({ root, now: () => base + 200 * 60_000 }).recover({ transcribe: async () => ({ ok: true, text: 'The recording I was making about the Durban trip, flights on Monday.' }) })).words

    const reader = new Recordings({ root, now: () => base + 200 * 60_000 })
    const all = await reader.list({})
    expect(all.map((item) => item.id)).toEqual([third.id, second.id, first.id])
    expect(all[0]).toMatchObject({ status: 'recovered', source: 'message box microphone', chat: 'c3', audioExists: true, transcriptState: 'complete', durationSeconds: 1, time: '2026-10-26 11:00' })
    expect(all[1]).toMatchObject({ status: 'finished', source: 'voice call', durationSeconds: 2 })
    expect((await reader.list({ query: 'durban' })).map((item) => item.id)).toEqual([third.id])
    expect((await reader.list({ since: base + 30 * 60_000 })).map((item) => item.id)).toEqual([third.id, second.id])
    expect((await reader.list({ limit: 1 })).map((item) => item.id)).toEqual([third.id])

    const tools = recordingsTools(reader, () => base + 200 * 60_000)
    const list = tools.find((tool) => tool.spec.name === 'recordings_list')!
    const get = tools.find((tool) => tool.spec.name === 'recordings_get')!
    const ctx = {} as never
    const listed = await list.run({ query: 'Durban trip' }, ctx)
    expect(listed).toContain(third.id)
    expect(listed).toContain('recovered')
    expect(listed).toContain('flights on Monday')
    expect(listed).not.toContain(first.id)
    const full = await get.run({ id: third.id }, ctx)
    expect(full).toContain('The recording I was making about the Durban trip, flights on Monday.')
    expect(full).toContain('What the live words had said: The recording I was making about the Durban trip')
    expect(full).toContain(join(third.dir, 'audio.wav'))
    expect(await get.run({ id: '20261026-090000-ffff' }, ctx)).toBe('No recording 20261026-090000-ffff.')
    expect(await list.run({ since: 'last full moon' }, ctx)).toMatch(/Could not read/)
  })

  it('reads "today", "3h" and local dates', () => {
    const now = new Date(2026, 9, 26, 15, 30).getTime()
    expect(parseSince('today', now)).toBe(new Date(2026, 9, 26).getTime())
    expect(parseSince('yesterday', now)).toBe(new Date(2026, 9, 25).getTime())
    expect(parseSince('3h', now)).toBe(now - 3 * 3_600_000)
    expect(parseSince('2026-10-26 14:00', now)).toBe(new Date(2026, 9, 26, 14, 0).getTime())
  })

  it('are read-only, in every agent toolset, and every agent prompt says how to find recordings', () => {
    expect(READ_ONLY_TOOLS.has('recordings_list')).toBe(true)
    expect(READ_ONLY_TOOLS.has('recordings_get')).toBe(true)
    const tools = buildWorkerToolset({ store: {} as never, recordings: new Recordings({ root }) })
    expect(tools.map((tool) => tool.spec.name)).toEqual(expect.arrayContaining(['recordings_list', 'recordings_get']))
    const prompt = buildSystemPrompt({ settings: DEFAULT_SETTINGS, now: new Date(), platform: 'win32', memories: [], goals: [], tasks: [], latestUserText: '', timeZone: 'UTC' })
    expect(prompt).toContain(RECORDINGS_LINE)
    expect(buildSystemPrompt({ settings: DEFAULT_SETTINGS, now: new Date(), platform: 'win32', memories: [], goals: [], tasks: [], latestUserText: '', timeZone: 'UTC', role: 'helper' })).toContain('recordings_list')
  })
})

// ---- a linked device's mic, and calls -----------------------------------------------------------------------

describe('recordings that pass through the voice service', () => {
  function voice(recordings: Recordings): VoiceService {
    return new VoiceService({
      secrets: { get: () => null, set: () => undefined, delete: () => undefined },
      settings: { get: () => DEFAULT_SETTINGS, save: () => undefined },
      store: {} as never,
      runner: { send: async () => undefined, state: () => ({ running: false, waiting: [] }) as never },
      emit: () => undefined,
      recordings,
    })
  }

  it("a linked device's message box mic is written here a second at a time and gets its words at the end", async () => {
    const recordings = new Recordings({ root, flushMs: 40 })
    const service = voice(recordings)
    const id = service.recordStart({ chat: 'c2' })
    expect(id).not.toBeNull()
    service.recordChunk(id!, speech(1))
    const dir = await onlyRecordingDir()
    await until(() => chunkFiles(dir).length === 1)
    service.recordChunk(id!, speech(1))
    await service.recordEnd(id!, { text: 'From my phone.' })
    expect(json<RecordingManifest>(join(dir, 'manifest.json'))).toMatchObject({ source: 'linked', chat: 'c2', status: 'finished', transcript: 'complete', bytes: 2 * SECOND })
    expect(readFileSync(join(dir, 'transcript.txt'), 'utf8')).toBe('From my phone.')
  })

  it('a linked device that goes away mid-recording leaves it on disk, ended as abandoned', async () => {
    let now = Date.now()
    const recordings = new Recordings({ root, flushMs: 20, idleMs: 1000, now: () => now })
    const service = voice(recordings)
    const id = service.recordStart({})!
    service.recordChunk(id, speech(1))
    now += 5000
    const dir = await onlyRecordingDir()
    await until(() => existsSync(join(dir, 'manifest.json')) && json<RecordingManifest>(join(dir, 'manifest.json')).ended === 'abandoned')
    expect(existsSync(join(dir, 'audio.wav'))).toBe(true)
    await until(() => recordings.activeIds().length === 0)
    expect(recordings.activeIds()).toEqual([])
  })
})

describe('a dictation saved on a linked phone (30 Oct 2026)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rec-phone-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const note = (text: string, state = 'done') => phoneDictationNote({ id: '20261030-105630', startedAt: Date.parse('2026-10-30T08:56:30Z'), durationMs: 150_000, text, state, chat: 'main' }, 'dev_phone', "Ayanda's A35")

  it('shows in recordings_list as from the phone, with its words and no audio', async () => {
    const store = new Recordings({ root })
    const id = await store.fromDevice(note('everything I said on the phone')!)
    const [row] = await store.list()
    expect(row?.id).toBe(id)
    expect(row?.source).toBe('phone')
    expect(row?.target).toBe("Ayanda's A35")
    expect(row?.durationSeconds).toBe(150)
    expect(row?.audioExists).toBe(false)
    expect(row?.transcriptState).toBe('complete')
    expect((await store.get(id))?.transcript).toBe('everything I said on the phone')
    expect(await store.list({ query: 'said on the phone' })).toHaveLength(1)
  })

  it('sent again it updates the same row, and never leaves fewer words', async () => {
    const store = new Recordings({ root })
    const id = await store.fromDevice(note('short', 'interrupted')!)
    expect((await store.get(id))?.transcriptState).toBe('partial')
    await store.fromDevice(note('short and then much longer')!)
    await store.fromDevice(note('short')!)
    expect(await store.list()).toHaveLength(1)
    expect((await store.get(id))?.transcript).toBe('short and then much longer')
  })

  it('a recovery pass leaves it alone', async () => {
    const store = new Recordings({ root })
    const id = await store.fromDevice(note('words')!)
    await new Recordings({ root }).recover({})
    expect((await store.get(id))?.status).toBe('finished')
    expect((await store.get(id))?.transcript).toBe('words')
  })

  it('refuses what is not a note, and a linked device may call it', () => {
    expect(phoneDictationNote({ id: '../../evil', startedAt: 1, durationMs: 1, text: 'x' }, 'd', 'n')).toBeNull()
    expect(phoneDictationNote({ id: '20261030-105630', startedAt: 1, durationMs: 1 }, 'd', 'n')).toBeNull()
    expect(phoneDictationNote('nope', 'd', 'n')).toBeNull()
    expect(RPC_ALLOWED.has('recordings.fromDevice')).toBe(true)
    expect(RPC_CHANNELS['recordings.fromDevice']).toBeDefined()
  })
})
