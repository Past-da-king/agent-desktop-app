/**
 * The one tool registry. Every group is one line, so a later milestone adds its tools by appending a
 * single line here (routines in M7, files/shell in M8, browser in M9, helpers in M10).
 *
 * The main agent gets everything, plus the helper tools, plus a budget on its action tools. The
 * worker toolset (what a helper runs with) is the same groups without the helper tools and without
 * the budget.
 */
import { DEFAULT_SETTINGS, type Tool } from '@agent/core'

import { unavailableBrowser, type BrowserDriver } from '../browser/types'
import type { AppsService } from '../apps/service'
import type { LearnedStore } from '../apps/store'
import { appTools } from '../tools/apps'
import { codeTools } from '../tools/code'
import { browserTools } from '../tools/browser'
import { browserProTools } from '../tools/browser-pro'
import { coreTools, type CoreToolDeps } from '../tools/core'
import { fileTools } from '../tools/files'
import { memoryTools } from '../tools/memory'
import { routineTools } from '../tools/routines'
import { shellTools } from '../tools/shell'
import { taskTools } from '../tools/tasks'
import { browserRunner, webAppTools } from '../tools/webapps'
import { budgeted, type StepBudget } from './budget'
import { browserOwner } from '../browser/owner'
import type { DataStore } from './data'
import type { EnvironmentService } from './environment'
import { helperTools } from '../tools/helpers'
import type { HelperHost } from './helpers'
import type { SettingsView } from './runner'

export interface ToolsetDeps extends CoreToolDeps {
  /** The live settings. Without them the tools fall back to the defaults (tests, browser preview). */
  settings?: SettingsView
  /** Paths the person picked in this session; read and written without asking again. */
  filePicks?: Set<string>
  /** Opens the OS file picker for files_pick. */
  pickFiles?: () => Promise<string[]>
  /** Omitted in tests and before the window exists; the browser tools then say it is not open. */
  browser?: BrowserDriver
  agentName?: () => string
  /** Present in the main process: lets the main agent hand work to helpers. */
  helpers?: HelperHost
  /** Present for the main agent: action tools stop after this many steps in one turn. */
  mainBudget?: StepBudget
  /** The environment scan, so shell_run and run_code use only what is really here. */
  environment?: EnvironmentService
  /** Connected apps through Composio. Omitted in tests that do not need them. */
  apps?: AppsService
  /** Sites the agent learned. Omitted in tests that do not need them. */
  learned?: LearnedStore
}

/**
 * The tools the main agent always does itself: memory, goals and tasks, asking, the report card and
 * the helper controls. Everything else (web, files, shell, code, the browser, routines) is an action
 * and is budgeted or handed to a helper.
 */
const MAIN_OWN_TOOLS: ReadonlySet<string> = new Set([
  'now',
  'ask_user',
  'request_approval',
  'notify_user',
  'report',
  'memory_search',
  'memory_get',
  'memory_save',
  'memory_update',
  'task_add',
  'task_list',
  'task_update',
  'goal_create',
  'delegate',
  'helper_steer',
  'helper_push',
  'helpers_status',
  'helper_stop',
  // Reserved for M7: routines are the main agent's to propose; a helper carries them out.
  'routine_create',
  'routine_list',
  'routine_delete',
])

/** Everything a helper may use: all the working groups, never delegate or helper_*. */
/** Every tool runs as its agent, so the browser gives each agent (main, routine, each helper) its own tab. */
function asOwner(tools: Tool[]): Tool[] {
  return tools.map((tool) => ({
    spec: tool.spec,
    run: (input, ctx) => browserOwner.run({ owner: ctx.owner ?? ctx.agentLabel }, () => tool.run(input, ctx)),
  }))
}

export function buildWorkerToolset(deps: ToolsetDeps): Tool[] {
  const settings = deps.settings ?? { get: () => DEFAULT_SETTINGS }
  const name = deps.agentName
  return asOwner([
    ...coreTools(deps), // now, ask_user, request_approval, notify_user, web_fetch, report
    ...memoryTools(deps.store), // memory_search, memory_get, memory_save, memory_update
    ...taskTools(deps.store), // task_add, task_list, task_update, goal_create
    ...routineTools(deps.store, deps.now), // routine_create, routine_list, routine_delete
    ...fileTools({
      settings,
      ...(deps.filePicks === undefined ? {} : { picks: deps.filePicks }),
      ...(deps.pickFiles === undefined ? {} : { pickFiles: deps.pickFiles }),
    }), // files_list, files_read, files_write, files_find, files_pick, files_move
    ...shellTools({
      settings,
      platform: process.platform,
      ...(deps.environment === undefined ? {} : { environment: deps.environment }),
    }), // shell_run
    ...codeTools({
      platform: process.platform,
      ...(deps.environment === undefined ? {} : { environment: deps.environment }),
    }), // run_code
    ...browserTools({
      browser: deps.browser ?? unavailableBrowser,
      ...(name === undefined ? {} : { agentName: name }),
    }), // browser_open through browser_show_user
    ...appTools(deps.apps), // apps_connected, apps_find_tools, apps_run, apps_connect
    // browser_eval comes from browser-pro (value plus a log); learned apps keep browser_network and webapp_*
    ...webAppTools(deps.learned, deps.browser === undefined ? undefined : browserRunner(deps.browser)).filter((tool) => tool.spec.name !== 'browser_eval'), // webapp_*, browser_network
    ...browserProTools({ browser: deps.browser }), // browser_view, browser_fix, browser_snapshot, browser_act, browser_eval

  ])
}

export function buildToolset(deps: ToolsetDeps): Tool[] {
  const tools = buildWorkerToolset(deps)
  if (deps.helpers !== undefined) {
    tools.push(...helperTools(deps.helpers)) // delegate, helper_steer, helper_push, helpers_status, helper_stop
  }
  const budget = deps.mainBudget
  if (budget === undefined) return tools
  return tools.map((tool) => (MAIN_OWN_TOOLS.has(tool.spec.name) ? tool : budgeted(tool, budget)))
}

/** Re-exported so a caller only needs this module to build a toolset. */
export type { DataStore }
