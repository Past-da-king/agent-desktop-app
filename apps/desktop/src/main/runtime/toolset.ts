/**
 * The one tool registry. Every group is one line, so a later milestone adds its tools by appending a
 * single line here (routines in M7, files/shell in M8, browser in M9, helpers in M10).
 *
 * The main agent gets everything, plus the helper tools, plus a budget on its action tools. The
 * worker toolset (what a helper runs with) is the same groups without the helper tools and without
 * the budget.
 */
import { DEFAULT_SETTINGS, type PastChatHit, type Tool } from '@agent/core'

import { unavailableBrowser, type BrowserDriver } from '../browser/types'
import type { AppsService } from '../apps/service'
import type { LearnedStore } from '../apps/store'
import { appTools } from '../tools/apps'
import { codeTools } from '../tools/code'
import { browserTools } from '../tools/browser'
import { browserProTools } from '../tools/browser-pro'
import { browserDevtoolsTools } from '../tools/browser-devtools'
import { devtoolsOf } from '../browser/devtools'
import { coreTools, type CoreToolDeps } from '../tools/core'
import { fileTools } from '../tools/files'
import { memoryTools } from '../tools/memory'
import { chatTools } from '../tools/chats'
import { routineTools } from '../tools/routines'
import { shellTools } from '../tools/shell'
import { taskTools } from '../tools/tasks'
import { workerTools as backgroundWorkerTools, type WorkerToolDeps } from '../tools/workers'
import { browserRunner, webAppTools } from '../tools/webapps'
import type { StepBudget } from './budget'
import { browserOwner } from '../browser/owner'
import { voiceNoteTool, type VoiceNoteMaker } from '../tools/voice-note'
import type { DataStore } from './data'
import type { EnvironmentService } from './environment'
import { helperTools } from '../tools/helpers'
import { gateTool } from '../tools/profile-gate'
import { profileTools } from '../tools/profiles'
import { projectTools, type ProjectToolDeps } from '../tools/projects'
import type { HelperHost } from './helpers'
import type { SettingsView } from './runner'
import { deviceTools, type DeviceToolDeps } from '../tools/devices'
import { deviceAgentTools, withDeviceArg, type DeviceToolHub } from '../devices/device-tools'
import { appControlTools, appUpdateTools, type AppControlDeps } from '../tools/app-control'
import { appActionTools } from '../tools/app-actions'
import { vaultTools } from '../tools/vault'
import { guardTools } from '../vault/guard'
import type { VaultStore } from '../vault/store'
import type { BrowserVault } from '../vault/browser-vault'

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
  /** Makes voice notes (the voice module). Main agent only. */
  voiceNotes?: () => VoiceNoteMaker | null
  /** Past-chat search (memory/service.ts). Without it there are no chats_search and chat_read tools. */
  searchChats?: (query: string, limit: number) => Promise<PastChatHit[]>
  /** Main agent only: projects and messaging between the main thread and project chats (tools/projects.ts). */
  projects?: Omit<ProjectToolDeps, 'store'>
  /** Main agent only: open_url and send_file act on the device the person is using (tools/devices.ts). */
  devices?: Omit<DeviceToolDeps, 'store'>
  /** Shared device tools (s11): devices_list, device_tool, and a `device` argument on the browser and asking tools. */
  deviceHub?: () => DeviceToolHub | null
  /** Background workers (workers/). Without them there are no worker_* tools. */
  workers?: WorkerToolDeps
  /**
   * The app's own controls (tools/app-control.ts): Devices and Settings for every agent, installing an update for
   * the main agent only. Without it there are none.
   */
  appControl?: AppControlDeps
  /**
   * The Vault (vault/store.ts): vault_* tools, and every tool wrapped by the vault guard so `{{vault:ref}}` works in
   * its input and no vault value comes back out. Without it there is no vault.
   */
  vault?: VaultStore
  /** The Vault in the browser: vault_passkey arms a passkey for an agent after the person's yes. */
  browserVault?: BrowserVault
}

/** With Devices: the device tools, and the local ones able to run on another device. */
function withDevices(tools: Tool[], deps: ToolsetDeps): Tool[] {
  const hub = deps.deviceHub
  if (hub === undefined) return tools
  return [...withDeviceArg(tools, hub), ...deviceAgentTools({ hub })]
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
  'chats_search',
  'chat_read',
  'task_add',
  'task_list',
  'task_update',
  'goal_create',
  'delegate',
  'helper_steer',
  'helper_push',
  'helpers_status',
  'helper_stop',
  'voice_note',
  // Reserved for M7: routines are the main agent's to propose; a helper carries them out.
  'routine_create',
  'routine_list',
  'routine_update',
  'routine_delete',
  'profile_create',
  'project_list',
  'project_create',
  'project_update',
  'project_chat_start',
  'project_chat_send',
  'project_open',
  'message_main',
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
  // The vault guard sits outermost of all: what any tool returns, on any path, has vault values taken out.
  return guardTools(workerToolsets(deps), deps.vault)
}

function workerToolsets(deps: ToolsetDeps): Tool[] {
  const tools = withDevices(workerTools(deps), deps)
  const apps = deps.apps
  // Outermost, so everything a tool does (the profile switch included) is done as its own agent.
  if (apps === undefined) return asOwner(tools)
  // Each helper's profile: its own browser sign-ins and only its learned apps (profile-gate.ts).
  const browser = deps.browser
  return asOwner(tools.map((tool) =>
    gateTool(tool, {
      profileOf: (ctx) => apps.profileOf(ctx.profile),
      partitionOf: (id) => apps.profiles.partitionOf(id),
      ...(browser?.usePartition === undefined ? {} : { usePartition: (partition: string) => browser.usePartition?.(partition) }),
      ...(deps.learned === undefined ? {} : { learned: deps.learned }),
      addLearned: (profileId, appId) => apps.profiles.setLearned(profileId, appId, true),
    }),
  ))
}

function workerTools(deps: ToolsetDeps): Tool[] {
  const settings = deps.settings ?? { get: () => DEFAULT_SETTINGS }
  const name = deps.agentName
  return [
    ...coreTools(deps), // now, ask_user, request_approval, notify_user, web_fetch, report
    ...memoryTools(deps.store), // memory_search, memory_get, memory_save, memory_update
    ...(deps.searchChats === undefined ? [] : chatTools({ store: deps.store, search: deps.searchChats })), // chats_search, chat_read
    ...taskTools(deps.store), // task_add, task_list, task_update, goal_create
    ...routineTools(deps.store, deps.now), // routine_create, routine_list, routine_update, routine_delete
    ...backgroundWorkerTools(deps.workers), // worker_guide, worker_create, worker_update, worker_test, worker_list, worker_logs, worker_events, worker_control, worker_delete, worker_secret_set
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
      settings,
      platform: process.platform,
      ...(deps.environment === undefined ? {} : { environment: deps.environment }),
    }), // run_code
    ...browserTools({
      browser: deps.browser ?? unavailableBrowser,
      ...(name === undefined ? {} : { agentName: name }),
    }), // browser_open through browser_show_user
    ...appTools(deps.apps), // apps_connected, apps_find_tools, apps_run, apps_connect
    // browser_eval comes from browser-pro (value plus a log); learned apps keep browser_network and webapp_*
    ...webAppTools(deps.learned, deps.browser === undefined ? undefined : browserRunner(deps.browser)).filter((tool) => tool.spec.name !== 'browser_eval' && tool.spec.name !== 'browser_network'), // webapp_*
    ...browserProTools({ browser: deps.browser }), // browser_view, browser_fix, browser_snapshot, browser_act, browser_eval
    // The developer tools replace the learned apps' in-page network watcher: every tab records from the start.
    ...browserDevtoolsTools({ devtools: () => devtoolsOf(deps.browser) }), // browser_network, browser_network_get, browser_fetch, browser_console, browser_inspect, browser_storage
    ...(deps.appControl?.invoker === undefined ? [] : appActionTools({ invoker: deps.appControl.invoker })), // app_actions, app_action: every button in the window
    ...(deps.vault === undefined ? [] : vaultTools({ vault: deps.vault, ...(deps.browser === undefined ? {} : { browser: deps.browser }), ...(deps.browserVault === undefined ? {} : { browserVault: deps.browserVault }) })), // vault_list, vault_fill, vault_login, vault_save, vault_reveal
    ...(deps.appControl === undefined ? [] : appControlTools(deps.appControl)), // devices_status, devices_switch, device_pair_offer, device_join, device_remove, device_roles, device_order, device_share, devices_firewall_allow, devices_addresses, settings_get, settings_set
  ]
}

export function buildToolset(deps: ToolsetDeps): Tool[] {
  const tools = buildWorkerToolset(deps)
  if (deps.helpers !== undefined) {
    tools.push(...helperTools(deps.helpers)) // delegate, helper_steer, helper_push, helpers_status, helper_stop
    tools.push(...profileTools(deps.apps, deps.learned)) // profile_create
  }
  if (deps.projects !== undefined) tools.push(...projectTools({ store: deps.store, ...deps.projects })) // project_list, project_create, project_update, project_chat_start, project_chat_send, message_main, project_open
  if (deps.devices !== undefined) {
    const own = deviceTools({ store: deps.store, ...deps.devices })
    tools.push(...asOwner(deps.deviceHub === undefined ? own : withDeviceArg(own, deps.deviceHub))) // open_url, send_file
  }
  // Installing an update ends the app, so only the main agent may (helpers resume after the restart).
  if (deps.appControl !== undefined) tools.push(...asOwner(appUpdateTools(deps.appControl))) // app_update
  // Voice notes are for the person only, so helpers never get this.
  if (deps.voiceNotes !== undefined) tools.push(asOwner([voiceNoteTool(deps.store, deps.voiceNotes)])[0]!)
  // No step counter any more (21 Oct 2026): the prompt says to hand big work to helpers, nothing cuts a turn short.
  // The ones added here are guarded too (the worker ones already are; guardTools skips a tool it has wrapped).
  return guardTools(tools, deps.vault)
}

/** Re-exported so a caller only needs this module to build a toolset. */
export type { DataStore }
