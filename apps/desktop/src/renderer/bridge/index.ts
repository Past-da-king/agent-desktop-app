import type { AgentApi } from '@agent/core'

import { localChat } from './local-chat'
import { mockAgent } from './mock'

/** In Electron this is the preload bridge; in a plain browser it is the in-memory mock. */
export const agent: AgentApi = window.agent ?? mockAgent

/**
 * Chat runs on the mock until M6. In the browser that is the mock bridge itself; in Electron the
 * same echo is written through the real local store so the UI behaves the same.
 */
export const chat: AgentApi['chat'] = agent.platform === 'web' ? agent.chat : localChat(agent)
