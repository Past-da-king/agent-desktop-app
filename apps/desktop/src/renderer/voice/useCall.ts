/**
 * The live call in the renderer: open the sheet, start the microphone, stream it to the main
 * process, play what comes back, keep the captions and the visuals. The Gemini side is all in main.
 */
import type { CallEvent, CallLine, CallState, CallVisual } from '@agent/core'
import { create } from 'zustand'

import { agent } from '../bridge'
import { refreshEntity } from '../state/useData'
import { MicError, Player, startCapture, type Capture } from './audio'

interface CallStore {
  open: boolean
  state: CallState
  message: string
  lines: CallLine[]
  visuals: CallVisual[]
  muted: boolean
  startedAt: number
  /** Opens the sheet and connects. Without a key the sheet shows the calm "add a key" state. */
  start(): Promise<void>
  hangUp(): Promise<void>
  toggleMute(): void
}

let capture: Capture | null = null
let player: Player | null = null
let off: (() => void) | null = null
const preview = agent.platform === 'web' && agent.remote === undefined

/** How loud the call is right now, 0 to 1: the agent while it talks, otherwise the person. */
export function callLevel(now: number = performance.now()): number {
  const { state, lines } = useCall.getState()
  if (preview) return previewLevel(state, lines, now)
  const theirs = player?.level() ?? 0
  const mine = capture?.level() ?? 0
  return Math.max(theirs, mine)
}

/** The preview has no audio, so the orb gets a believable fake: speech-like bursts while words arrive. */
function previewLevel(state: CallState, lines: CallLine[], now: number): number {
  const t = now / 1000
  const talking = state === 'speaking' || (state === 'listening' && lines.at(-1)?.who === 'you')
  if (!talking) return 0.04 + 0.03 * Math.sin(t * 2)
  const syllables = Math.abs(Math.sin(t * 9.1)) * Math.abs(Math.sin(t * 3.7 + 1))
  return Math.min(1, 0.18 + 0.6 * syllables)
}

function onEvent(event: CallEvent): void {
  const set = useCall.setState
  switch (event.type) {
    case 'state':
      set({ state: event.state, message: event.message ?? '' })
      if (event.state === 'error') stopAudio()
      return
    case 'audio':
      if (player === null) player = new Player()
      player.enqueue(event.data)
      return
    case 'interrupted':
      player?.flush()
      return
    case 'caption':
      set((current) => {
        const index = current.lines.findIndex((line) => line.id === event.line.id)
        if (index < 0) return { lines: [...current.lines, event.line] }
        const lines = current.lines.slice()
        lines[index] = event.line
        return { lines }
      })
      return
    case 'visual':
      set((current) => ({ visuals: [...current.visuals.filter((item) => item.id !== event.visual.id), event.visual] }))
      refreshEntity('chat_item')
      return
  }
}

function stopAudio(): void {
  capture?.stop()
  capture = null
  player?.close()
  player = null
}

export const useCall = create<CallStore>((set, get) => ({
  open: false,
  state: 'ended',
  message: '',
  lines: [],
  visuals: [],
  muted: false,
  startedAt: 0,

  start: async () => {
    if (get().open) return
    set({ open: true, state: 'connecting', message: '', lines: [], visuals: [], muted: false, startedAt: Date.now() })
    const settings = await agent.settings.get()
    if (!settings.hasVoiceKey) {
      set({ state: 'error', message: 'nokey' })
      return
    }
    off?.()
    off = agent.voice.onCall(onEvent)
    const result = await agent.voice.callStart()
    if (!get().open) return
    if (!result.ok) {
      set({ state: 'error', message: result.message })
      return
    }
    set({ startedAt: Date.now() })
    try {
      capture = await startCapture((pcm) => {
        if (!useCall.getState().muted) agent.voice.callAudio(pcm)
      })
    } catch (error) {
      // The preview has no microphone to speak of; the scripted call runs without it.
      if (preview) return
      set({ state: 'error', message: error instanceof MicError ? error.message : 'Could not use the microphone.' })
      await agent.voice.callEnd()
    }
  },

  hangUp: async () => {
    if (!get().open) return
    stopAudio()
    set({ open: false })
    try {
      await agent.voice.callEnd()
    } finally {
      off?.()
      off = null
      set({ state: 'ended' })
      refreshEntity('chat_item')
    }
  },

  toggleMute: () => {
    const muted = !get().muted
    set({ muted })
    capture?.setMuted(muted)
    void agent.voice.callMute(muted)
  },
}))
