/**
 * The hotkeys and dictation halves of `AgentApi` over IPC, kept apart from main/ipc.ts so they do not touch
 * the shared handlers. Arguments are checked: the renderer is untrusted.
 */
import type { HotkeyStatus } from '@agent/core'

import { CHANNELS } from '../../shared/channels'
import type { IpcMainLike } from '../ipc'
import type { IpcMainOnLike } from '../voice/ipc'

const MAX_CHUNK = 64 * 1024

export interface DictationIpcDeps {
  hotkeyStatus: () => HotkeyStatus[]
  pauseHotkeys: (paused: boolean) => void
  audio: (session: number, pcm: Buffer) => void
  micState: (session: number, ok: boolean, message: string) => void
  stop: () => void
  pillReady: () => void
  /** The message box's microphone in the window `sender` belongs to. */
  toggle: (sender: unknown, mode: 'plain' | 'clean', chat: string | null) => void
  cancel: () => void
  retry: () => void
}

export function registerDictationIpc(deps: DictationIpcDeps, ipcMain: IpcMainLike & Partial<IpcMainOnLike>): void {
  ipcMain.handle(CHANNELS.hotkeys.status, async () => deps.hotkeyStatus())
  ipcMain.handle(CHANNELS.hotkeys.pause, async (_event, paused) => {
    deps.pauseHotkeys(paused === true)
  })
  ipcMain.handle(CHANNELS.dictation.micState, async (_event, session, ok, message) => {
    if (typeof session !== 'number' || !Number.isInteger(session)) throw new Error('session must be a number')
    deps.micState(session, ok === true, typeof message === 'string' ? message.slice(0, 300) : '')
  })
  ipcMain.handle(CHANNELS.dictation.stop, async () => {
    deps.stop()
  })
  ipcMain.handle(CHANNELS.dictation.ready, async () => {
    deps.pillReady()
  })
  ipcMain.handle(CHANNELS.dictation.toggle, async (event, mode, chat) => {
    const chatId = typeof chat === 'string' && /^[\w:-]{1,100}$/.test(chat) ? chat : null
    deps.toggle((event as { sender?: unknown } | null)?.sender ?? null, mode === 'clean' ? 'clean' : 'plain', chatId)
  })
  ipcMain.handle(CHANNELS.dictation.cancel, async () => {
    deps.cancel()
  })
  ipcMain.handle(CHANNELS.dictation.retry, async () => {
    deps.retry()
  })

  // Audio chunks are fire and forget (ipcRenderer.send), about ten a second.
  const onAudio = (_event: unknown, session: unknown, pcm: unknown): void => {
    if (typeof session !== 'number' || !(pcm instanceof Uint8Array) || pcm.byteLength > MAX_CHUNK) return
    deps.audio(session, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  }
  if (ipcMain.on !== undefined) ipcMain.on(CHANNELS.dictation.audio, onAudio)
  else ipcMain.handle(CHANNELS.dictation.audio, onAudio)
}
