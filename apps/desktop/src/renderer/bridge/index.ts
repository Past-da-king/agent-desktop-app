import type { AgentApi } from '@agent/core'

import { currentChat } from '../lib/current-chat'

/** True when a node served this page as its web UI (main/devices/service.ts tags index.html). */
const servedByNode = document.querySelector('meta[name="agent-remote"]') !== null

/**
 * In Electron this is the preload bridge. On another device, opened from a node at /app/, it is the remote bridge
 * over the wire. In a plain browser it is the in-memory mock, loaded only then, so the preview's demo data and fake
 * chat never ship in the app's own bundle.
 */
export const agent: AgentApi =
  window.agent ?? (servedByNode ? await (await import('./remote')).createRemoteAgent() : (await import('./mock')).mockAgent)

/**
 * Chat is the real main-process runner in Electron and the demo echo in the browser preview. A message sent
 * without naming a chat goes to the chat on screen.
 */
export const chat: AgentApi['chat'] = {
  ...agent.chat,
  send: (text, attachments, target, options) => (options === undefined ? agent.chat.send(text, attachments, target ?? currentChat()) : agent.chat.send(text, attachments, target ?? currentChat(), options)),
}
