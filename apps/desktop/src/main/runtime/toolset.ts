/**
 * The one tool registry. Every group is one line, so a later milestone adds its tools by appending a
 * single line here (routines in M7, files/shell in M8, browser in M9, helpers in M10).
 */
import type { Tool } from '@agent/core'

import { coreTools, type CoreToolDeps } from '../tools/core'
import { memoryTools } from '../tools/memory'
import { taskTools } from '../tools/tasks'
import type { DataStore } from './data'

export type ToolsetDeps = CoreToolDeps

export function buildToolset(deps: ToolsetDeps): Tool[] {
  return [
    ...coreTools(deps), // now, ask_user, request_approval, notify_user, web_fetch, report
    ...memoryTools(deps.store), // memory_search, memory_get, memory_save, memory_update
    ...taskTools(deps.store), // task_add, task_list, task_update, goal_create
  ]
}

/** Re-exported so a caller only needs this module to build a toolset. */
export type { DataStore }
