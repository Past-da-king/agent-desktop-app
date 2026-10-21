import type { AgentApi } from '@agent/core'

import { currentChat } from '../lib/current-chat'
import { mockAgent } from './mock'

/** In Electron this is the preload bridge; in a plain browser it is the in-memory mock. */
export const agent: AgentApi = window.agent ?? mockAgent

/**
 * Chat is the real main-process runner in Electron and the demo echo in the browser preview. A message sent
 * without naming a chat goes to the chat on screen.
 */
export const chat: AgentApi['chat'] = {
  ...agent.chat,
  send: (text, attachments, target) => agent.chat.send(text, attachments, target ?? currentChat()),
}
