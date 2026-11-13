/**
 * "Show me how" (10 Nov 2026), the part the window and the main process share: how the quick chat bar knows a line
 * is a how-to, the channel names, and what the bar is told about a walk. No Electron, no Node.
 */
import type { ShowMeState } from '@agent/core'

export type { ShowMeApi, ShowMeStart, ShowMeState } from '@agent/core'

export const SHOWME_CHANNELS = {
  start: 'agent:showme.start',
  stop: 'agent:showme.stop',
  state: 'agent:showme.state',
} as const

export const SHOWME_EVENTS = {
  state: 'agent:evt:showme.state',
} as const

export const SHOWME_IDLE: ShowMeState = { running: false, phase: 'idle', question: '', step: 0, of: 0, label: '', message: '', failed: false, at: 0 }

const HOW_TO = /^\s*(?:(?:hey|hi|ok|okay|please)[,\s]+)?(?:show me (?:how|where)\b|how (?:do|can|would|should) (?:i|you|we)\b|how to\b|where (?:do|can) i\b|where is\b|guide me\b|walk me through\b)/i
const PREFIX = /^\s*(?:\/show|\/guide|show:|guide:)\s*/i

/**
 * Is this line a how-to for the screen? Only when it says so in its first words ("how do I...", "show me how...",
 * "where is...") or starts with /show. Anything else is a message for the chat, as before: never a guess.
 * Returns the question to walk, or null.
 */
export function howToQuestion(text: string): string | null {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line === '') return null
  if (PREFIX.test(line)) {
    const rest = line.replace(PREFIX, '').trim()
    return rest === '' ? null : rest
  }
  return HOW_TO.test(line) && line.split(' ').length >= 3 ? line : null
}
