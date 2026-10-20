/**
 * The voice half of `AgentApi` over IPC. Kept apart from main/ipc.ts so voice can grow without
 * touching the shared handlers. Arguments are checked: the renderer is untrusted.
 */
import { CHANNELS, EVENTS } from '../../shared/channels'
import type { IpcMainLike } from '../ipc'
import type { VoiceService } from './service'

export interface IpcMainOnLike {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

const MAX_KEY = 8192
const MAX_SPEAK = 20_000
const MAX_DICTATION = 16_000 * 2 * 60 * 5
const MAX_CHUNK = 64 * 1024

export function registerVoiceIpc(
  voice: VoiceService,
  ipcMain: IpcMainLike & Partial<IpcMainOnLike>,
): void {
  ipcMain.handle(CHANNELS.voice.setKey, async (_event, key) => {
    if (typeof key !== 'string' || key.length > MAX_KEY) throw new Error('key must be text')
    voice.setKey(key)
  })
  ipcMain.handle(CHANNELS.voice.check, async () => voice.check())
  ipcMain.handle(CHANNELS.voice.transcribe, async (_event, pcm) => voice.transcribe(bytes(pcm, MAX_DICTATION)))
  ipcMain.handle(CHANNELS.voice.speak, async (_event, text) => {
    if (typeof text !== 'string' || text.length > MAX_SPEAK) throw new Error('text must be text')
    return voice.speak(text)
  })
  ipcMain.handle(CHANNELS.voice.noteAudio, async (_event, file) => {
    if (typeof file !== 'string' || file.length > 120) throw new Error('file must be a note name')
    const audio = voice.noteAudio(file)
    return audio === null ? null : new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)
  })
  ipcMain.handle(CHANNELS.voice.callStart, async () => voice.callStart())
  ipcMain.handle(CHANNELS.voice.callMute, async (_event, muted) => {
    voice.callMute(muted === true)
  })
  ipcMain.handle(CHANNELS.voice.callEnd, async () => voice.callEnd())

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
