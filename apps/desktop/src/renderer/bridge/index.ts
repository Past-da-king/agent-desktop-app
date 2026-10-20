import type { AgentApi } from '@agent/core'

import { mockAgent } from './mock'

/** In Electron this is the preload bridge; in a plain browser it is the in-memory mock. */
export const agent: AgentApi = window.agent ?? mockAgent
