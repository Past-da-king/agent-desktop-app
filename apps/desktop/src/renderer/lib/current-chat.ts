/**
 * The chat the person has open. A plain module (no imports) so the bridge can read it without a cycle:
 * a message sent from anywhere (an OpenUI chip, the palette, a voice call) goes to the chat on screen.
 */
import { MAIN_CHAT } from '@agent/core'

const KEY = 'agent.chat'

function stored(): string {
  try {
    // The browser preview can open a chat straight away (?chat=...), for screenshots.
    const asked = new URLSearchParams(window.location.search).get('chat')
    if (asked !== null && /^[A-Za-z0-9_-]{1,64}$/.test(asked)) return asked
    const value = window.localStorage.getItem(KEY)
    return value !== null && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : MAIN_CHAT
  } catch {
    return MAIN_CHAT
  }
}

let current = stored()

export function currentChat(): string {
  return current
}

export function setCurrentChat(chat: string): void {
  current = chat
  try {
    window.localStorage.setItem(KEY, chat)
  } catch {
    // Remembering the open chat across restarts is a nicety.
  }
}
