/**
 * The one tool registry. Every group is one line, so a later milestone adds its tools by appending a
 * single line here (routines in M7, files/shell in M8, browser in M9, helpers in M10).
 */
import { DEFAULT_SETTINGS, type Tool } from '@agent/core'

import { codeTools } from '../tools/code'
import { coreTools, type CoreToolDeps } from '../tools/core'
import { fileTools } from '../tools/files'
import { memoryTools } from '../tools/memory'
import { shellTools } from '../tools/shell'
import { taskTools } from '../tools/tasks'
import type { DataStore } from './data'
import type { SettingsView } from './runner'

export interface ToolsetDeps extends CoreToolDeps {
  /** The live settings. Without them the tools fall back to the defaults (tests, browser preview). */
  settings?: SettingsView
  /** Paths the person picked in this session; read and written without asking again. */
  filePicks?: Set<string>
  /** Opens the OS file picker for files_pick. */
  pickFiles?: () => Promise<string[]>
}

export function buildToolset(deps: ToolsetDeps): Tool[] {
  const settings = deps.settings ?? { get: () => DEFAULT_SETTINGS }
  return [
    ...coreTools(deps), // now, ask_user, request_approval, notify_user, web_fetch, report
    ...memoryTools(deps.store), // memory_search, memory_get, memory_save, memory_update
    ...taskTools(deps.store), // task_add, task_list, task_update, goal_create
    ...fileTools({
      settings,
      ...(deps.filePicks === undefined ? {} : { picks: deps.filePicks }),
      ...(deps.pickFiles === undefined ? {} : { pickFiles: deps.pickFiles }),
    }), // files_list, files_read, files_write, files_find, files_pick, files_move
    ...shellTools({ settings }), // shell_run
    ...codeTools(), // run_code
  ]
}

/** Re-exported so a caller only needs this module to build a toolset. */
export type { DataStore }
