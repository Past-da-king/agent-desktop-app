/**
 * Read-aloud: one voice at a time. A message's "Read aloud" button and the "Speak replies" setting
 * both come through here, so starting one stops the other.
 */
import type { ChatEvent } from '@agent/core'
import { useEffect } from 'react'
import { create } from 'zustand'

import { agent } from '../bridge'
import { toast } from '../state/useToast'
import { Player } from './audio'
import { useCall } from './useCall'

interface SpeakerStore {
  /** The chat row being read, or '' for none. */
  speaking: string
  loading: string
}

export const useSpeaker = create<SpeakerStore>(() => ({ speaking: '', loading: '' }))

let player: Player | null = null
let ticket = 0

export function stopSpeaking(): void {
  ticket += 1
  player?.close()
  player = null
  useSpeaker.setState({ speaking: '', loading: '' })
}

export async function speakText(id: string, text: string): Promise<void> {
  stopSpeaking()
  const mine = ticket
  useSpeaker.setState({ loading: id })
  const result = await agent.voice.speak(text)
  if (mine !== ticket) return
  if (!result.ok) {
    useSpeaker.setState({ loading: '' })
    toast(result.error)
    return
  }
  const next = new Player()
  player = next
  next.onIdle = () => {
    if (player === next) stopSpeaking()
  }
  useSpeaker.setState({ loading: '', speaking: id })
  next.enqueue(result.data)
}

/** With "Speak replies" on, each finished reply is read out, unless a call is on. */
export function useSpeakReplies(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let since = 0
    return agent.chat.onEvent((event: ChatEvent) => {
      if (event.type === 'run_started') since = Date.now() - 50
      if (event.type !== 'run_finished' || event.error !== undefined || since === 0) return
      if (useCall.getState().open) return
      const from = since
      // Only the replies of this run, by index: never the whole chat table.
      void agent.data.where('chat_item', { kind: 'agent', since: from - 1, newestFirst: true, limit: 50 }).then((items) => {
        const replies = items
          .filter((item) => item.kind === 'agent' && item.createdAt >= from)
          .sort((a, b) => a.createdAt - b.createdAt)
        const last = replies.at(-1)
        if (last === undefined) return
        void speakText(last.id, replies.map((item) => item.text).join('\n\n'))
      })
    })
  }, [enabled])
}
