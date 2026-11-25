/**
 * The voice half of `AgentApi` over IPC. Kept apart from main/ipc.ts so voice can grow without
 * touching the shared handlers. Arguments are checked: the renderer is untrusted.
 */
import { CHANNELS, EVENTS } from '../../shared/channels'
import type { DeviceCall, VoiceTakeAck, VoiceTakeInput } from '@agent/core'

import { liveFromInput } from '../../shared/sender'
import { messageOrigin, originWithLive } from '../devices/origin'
import type { IpcMainLike } from '../ipc'
import { callHandoff, callTargets, type CallHandoffDeps } from './handoff'
import { liveTurn } from '../runtime/live-calls'
import type { VoiceService } from './service'

export interface IpcMainOnLike {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

const MAX_KEY = 8192
const MAX_SPEAK = 20_000
const MAX_DICTATION = 16_000 * 2 * 60 * 10
const MAX_CHUNK = 64 * 1024
/** A linked device sends its recording about a second at a time; allow a few seconds of slack. */
const MAX_RECORD_CHUNK = 16_000 * 2 * 10

export function registerVoiceIpc(
  voice: VoiceService,
  ipcMain: IpcMainLike & Partial<IpcMainOnLike>,
  /** Where a paired device's call hands its work (voice.callTargets, voice.callHandoff). */
  handoff?: CallHandoffDeps,
  /**
   * How a linked device's recording is written down: dictation's own transcription, which carries the person's names
   * and languages, rather than the plain one here (11 Nov 2026: a phone's dictation reached the desktop with no
   * vocabulary at all, so his names came back as whatever the model guessed).
   */
  transcribeDevice?: (pcm: Buffer, extra?: WholeExtra) => Promise<{ ok: boolean; text?: string; error?: string }>,
  /** Instant send: a dictated message's audio, by recording id (dictation/pending.ts). */
  takeAudio?: (input: VoiceTakeInput) => Promise<VoiceTakeAck>,
): void {
  ipcMain.handle(CHANNELS.voice.setKey, async (_event, key) => {
    if (typeof key !== 'string' || key.length > MAX_KEY) throw new Error('key must be text')
    voice.setKey(key)
  })
  ipcMain.handle(CHANNELS.voice.check, async () => voice.check())
  ipcMain.handle(CHANNELS.voice.transcribe, async (_event, pcm, rawExtra) => {
    const audio = bytes(pcm, MAX_DICTATION)
    // `{whole: true, names, languages}` (phone 0.15.75): the audio is the entire take, so ONE pass with these names and
    // languages added to the computer's own. Without it the call is a piece, as before.
    const extra = wholeExtra(rawExtra)
    return transcribeDevice === undefined ? voice.transcribe(audio) : transcribeDevice(audio, extra)
  })
  ipcMain.handle(CHANNELS.voice.takeAudio, async (_event, raw) => {
    if (takeAudio === undefined) return { ok: false, error: 'This computer cannot take dictated audio.' }
    return takeAudio(takeInput(raw))
  })
  ipcMain.handle(CHANNELS.voice.speak, async (_event, text) => {
    if (typeof text !== 'string' || text.length > MAX_SPEAK) throw new Error('text must be text')
    return voice.speak(text)
  })
  ipcMain.handle(CHANNELS.voice.noteAudio, async (_event, file, localOnly) => {
    if (typeof file !== 'string' || file.length > 120) throw new Error('file must be a note name')
    const audio = await voice.noteAudioForDevice(file, localOnly === true)
    return audio === null ? null : new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)
  })
  ipcMain.handle(CHANNELS.voice.liveToken, async () => voice.liveToken())
  ipcMain.handle(CHANNELS.voice.callSave, async (_event, record) => voice.callSave(deviceCall(record)))
  ipcMain.handle(CHANNELS.voice.callTurn, async (_event, turn) => voice.callTurn(liveTurn(turn)))
  ipcMain.handle(CHANNELS.voice.callTargets, async () => (handoff === undefined ? [] : callTargets(handoff)))
  ipcMain.handle(CHANNELS.voice.callHandoff, async (event, raw) => {
    const input = handoffInput(raw)
    if (handoff === undefined) return { ok: false, error: 'This computer cannot take work from a call.', ambiguous: [] }
    return callHandoff(handoff, input, originWithLive(messageOrigin(event), raw))
  })
  ipcMain.handle(CHANNELS.voice.callStart, async () => voice.callStart())
  ipcMain.handle(CHANNELS.voice.callMute, async (_event, muted) => {
    voice.callMute(muted === true)
  })
  ipcMain.handle(CHANNELS.voice.callEnd, async () => voice.callEnd())

  // A window that records by itself (a linked device's message box mic) keeps its recording here as it happens.
  ipcMain.handle(CHANNELS.voice.recordStart, async (_event, info) => {
    const chat = typeof info === 'object' && info !== null ? (info as { chat?: unknown }).chat : null
    return voice.recordStart({ chat: typeof chat === 'string' && /^[\w:-]{1,100}$/.test(chat) ? chat : null })
  })
  ipcMain.handle(CHANNELS.voice.recordChunk, async (_event, id, pcm) => {
    if (typeof id !== 'string' || id.length > 64) throw new Error('id must be a recording id')
    voice.recordChunk(id, bytes(pcm, MAX_RECORD_CHUNK))
  })
  ipcMain.handle(CHANNELS.voice.recordEnd, async (_event, id, outcome) => {
    if (typeof id !== 'string' || id.length > 64) throw new Error('id must be a recording id')
    const raw = typeof outcome === 'object' && outcome !== null ? (outcome as Record<string, unknown>) : {}
    await voice.recordEnd(id, {
      ...(typeof raw['text'] === 'string' ? { text: raw['text'].slice(0, 200_000) } : {}),
      ...(typeof raw['error'] === 'string' ? { error: raw['error'].slice(0, 300) } : {}),
      ...(raw['cancelled'] === true ? { cancelled: true } : {}),
    })
  })

  // Audio chunks are fire and forget (ipcRenderer.send), about ten a second.
  const onAudio = (_event: unknown, pcm: unknown): void => {
    try {
      voice.callAudio(bytes(pcm, MAX_CHUNK))
    } catch {
      // A malformed chunk is dropped; the call carries on.
    }
  }
  if (ipcMain.on !== undefined) ipcMain.on(CHANNELS.voice.callAudio, onAudio)
  else ipcMain.handle(CHANNELS.voice.callAudio, onAudio)
}

/** The event channel the service pushes call events on. */
export const VOICE_EVENT = EVENTS.voiceCall

function bytes(value: unknown, max: number): Buffer {
  if (!(value instanceof Uint8Array)) throw new Error('audio must be bytes')
  if (value.byteLength > max) throw new Error('audio is too long')
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

const MAX_CALL_LINES = 2_000
const MAX_LINE = 8_000

/** A device's call record, checked: the device is trusted to be paired, not to send well-formed data. */
export function deviceCall(value: unknown): DeviceCall {
  if (typeof value !== 'object' || value === null) throw new Error('call must be an object')
  const record = value as { startedAt?: unknown; durationMs?: unknown; lines?: unknown }
  const startedAt = Number(record.startedAt)
  const durationMs = Number(record.durationMs)
  if (!Number.isFinite(startedAt) || startedAt <= 0) throw new Error('startedAt must be a time')
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('durationMs must be a length')
  if (!Array.isArray(record.lines) || record.lines.length > MAX_CALL_LINES) throw new Error('lines must be a list')
  const lines = record.lines.flatMap((line: unknown) => {
    if (typeof line !== 'object' || line === null) return []
    const { who, text, at } = line as { who?: unknown; text?: unknown; at?: unknown }
    if ((who !== 'you' && who !== 'agent') || typeof text !== 'string' || text.trim() === '') return []
    return [{ who, text: text.slice(0, MAX_LINE), at: Number.isFinite(Number(at)) ? Number(at) : startedAt }] as DeviceCall['lines']
  })
  const out: DeviceCall = { startedAt, durationMs, lines }
  // A Live voice session is a call that can see: it saves as one call with its hand-offs folded inside (shared/sender.ts).
  const live = liveFromInput(value)
  const rec = value as { source?: unknown; session?: unknown; handoffs?: unknown }
  if (live !== null || rec.source === 'live') out.source = 'live'
  const session = live?.session !== undefined && live.session !== '' ? live.session : typeof rec.session === 'string' ? rec.session.trim().slice(0, 80) : ''
  if (session !== '') out.session = session
  if (Array.isArray(rec.handoffs)) {
    const list = rec.handoffs.slice(0, MAX_CALL_LINES).flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return []
      const { request, spoken, at } = entry as { request?: unknown; spoken?: unknown; at?: unknown }
      if (typeof request !== 'string' || request.trim() === '') return []
      return [{ request: request.slice(0, MAX_LINE), ...(typeof spoken === 'string' && spoken.trim() !== '' ? { spoken: spoken.slice(0, MAX_LINE) } : {}), at: Number.isFinite(Number(at)) ? Number(at) : startedAt }]
    })
    if (list.length > 0) out.handoffs = list
  }
  return out
}

const MAX_HANDOFF = 20_000

/** A call's hand-off from the wire, checked. */
function handoffInput(raw: unknown): { target: string; message: string; kind: 'main' | 'project' | 'helper' | ''; newChat: boolean } {
  if (typeof raw !== 'object' || raw === null) throw new Error('hand-off must be an object')
  const record = raw as Record<string, unknown>
  const target = typeof record['target'] === 'string' ? record['target'].slice(0, 200) : ''
  const message = record['message']
  if (typeof message !== 'string' || message.trim() === '' || message.length > MAX_HANDOFF) throw new Error('message must be text')
  const kind = record['kind']
  return {
    target,
    message,
    kind: kind === 'main' || kind === 'project' || kind === 'helper' ? kind : '',
    newChat: record['newChat'] === true,
  }
}

export interface WholeExtra {
  whole: boolean
  names: string[]
  languages: string[]
}

function strings(value: unknown, max: number, each: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '' && item.length <= each).slice(0, max) : []
}

/** The second argument of voice.transcribe, checked: undefined when it is not the whole-take form. */
export function wholeExtra(raw: unknown): WholeExtra | undefined {
  if (typeof raw !== 'object' || raw === null || (raw as { whole?: unknown }).whole !== true) return undefined
  const input = raw as { names?: unknown; languages?: unknown }
  return { whole: true, names: strings(input.names, 100, 60), languages: strings(input.languages, 6, 12) }
}

/** The input of voice.takeAudio, checked (the device is trusted to be paired, not to send well-formed data). */
export function takeInput(raw: unknown): VoiceTakeInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('take must be an object')
  const input = raw as Record<string, unknown>
  const id = input['id']
  if (typeof id !== 'string' || !/^[\w:-]{1,64}$/.test(id)) throw new Error('id must be a recording id')
  const out: VoiceTakeInput = { id }
  if (typeof input['chat'] === 'string' && /^[\w:-]{1,100}$/.test(input['chat'])) out.chat = input['chat']
  if (input['audio'] !== undefined && input['audio'] !== null) out.audio = new Uint8Array(bytes(input['audio'], MAX_DICTATION))
  if (typeof input['caption'] === 'string') out.caption = input['caption'].slice(0, 200_000)
  if (input['retry'] === true) out.retry = true
  const names = strings(input['names'], 100, 60)
  if (names.length > 0) out.names = names
  const languages = strings(input['languages'], 6, 12)
  if (languages.length > 0) out.languages = languages
  return out
}
