import type { AgentApi } from '@agent/core'

import { mockAgent } from './mock'

/** In Electron this is the preload bridge; in a plain browser it is the in-memory mock. */
export const agent: AgentApi = window.agent ?? mockAgent

/** Chat is the real main-process runner in Electron and the demo echo in the browser preview. */
export const chat: AgentApi['chat'] = agent.chat
