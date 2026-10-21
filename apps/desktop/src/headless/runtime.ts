/**
 * The agent runtime without Electron: the same modules `main/index.ts` startServices composes (Store, settings,
 * secrets, accounts, runner, helpers, routines, memory, connected and learned apps), with small adapters where the
 * desktop app uses Electron (paths, safeStorage, notifications, the browser, windows, dialogs).
 *
 * Kept as a parallel composition on purpose: index.ts is edited by other work, and the headless node must not pull
 * in anything that imports 'electron'. The app contract (every ipc handler) is collected into a table, so the node
 * server can serve the same methods over /v1/rpc that the window calls over IPC.
 */
import { mkdirSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'

import { EARLIER_CHATS_PROJECT, MEMORY_DAILY_ROUTINE, providerFor, type Tool } from '@agent/core'

import { AccountService } from '../main/account'
import { AccountStore, migrateLegacyAccount } from '../main/accounts'
import { ProfileStore } from '../main/apps/profiles'
import { AppsService } from '../main/apps/service'
import { ConnectedAppsFile, LearnedStore } from '../main/apps/store'
import { FileBrainLocks } from '../main/brain-locks'
import { Store } from '../main/db'
import { registerIpc, type IpcMainLike } from '../main/ipc'
import { Logger } from '../main/logger'
import { ChatIndex } from '../main/memory/chat-index'
import { registerMemoryHistoryIpc } from '../main/memory/history-ipc'
import { registerMemoryIpc } from '../main/memory/ipc'
import { dailyRoutineSlot, ensureDailyRoutine, recordDailyRun, resultLine } from '../main/memory/routine'
import { MemoryService } from '../main/memory/service'
import { MemoryTidy, TidyFile } from '../main/memory/tidy'
import { UpkeepFile } from '../main/memory/upkeep-log'
import { savePastedFile } from '../main/pasted'
import { adoptEarlierChats } from '../main/projects/earlier'
import { StepBudget } from '../main/runtime/budget'
import { CliHost } from '../main/runtime/cli-host'
import { hostEnvironment } from '../main/runtime/environment-host'
import { HelperManager } from '../main/runtime/helpers'
import { Runner } from '../main/runtime/runner'
import { Scheduler } from '../main/runtime/scheduler'
import { buildToolset, buildWorkerToolset } from '../main/runtime/toolset'
import { Secrets } from '../main/secrets'
import { SettingsStore } from '../main/settings'
import { EVENTS } from '../shared/channels'
import { FileKeyCipher } from './file-cipher'

/** What a headless node can do on its own device. Device commands (protocol s5.2) plug in through these. */
export interface DeviceActions {
  /** Open a web address for the person. A server has no screen; the node server routes it to the origin device. */
  openUrl(url: string): Promise<string> | string
  /** Show a notification for the person. */
  notify(title: string, body: string): void
}

export interface HeadlessOptions {
  dataDir: string
  /** Where the bundled node_modules live (the Claude Agent SDK is resolved from here). */
  appDir: string
  version: string
  /** Device commands; the default logs and says there is no screen here. */
  actions?: Partial<DeviceActions>
  /** Extra tools (tests). */
  extraTools?: Tool[]
  /** Skip the background memory and routine timers (tests that only run one turn). */
  quiet?: boolean
  /** Overrides how providers are made (tests point it at a local fake). */
  providerFactory?: ConstructorParameters<typeof Runner>[0]['providerFactory']
}

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

/** Every app-contract handler by channel, plus the events the window would get. */
export class HandlerTable implements IpcMainLike {
  readonly handlers = new Map<string, IpcHandler>()
  private readonly listeners = new Set<(channel: string, payload: unknown) => void>()

  handle(channel: string, listener: IpcHandler): void {
    this.handlers.set(channel, listener)
  }

  /** Calls a handler like the renderer would. The event carries the calling device for logging. */
  async invoke(channel: string, args: unknown[], caller = 'local'): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error(`No handler for ${channel}`)
    return handler({ sender: { id: -1 }, caller }, ...args)
  }

  onEvent(listener: (channel: string, payload: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  broadcast(channel: string, payload?: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(channel, payload)
      } catch {
        // One bad listener must not stop the others.
      }
    }
  }
}

export interface HeadlessRuntime {
  dataDir: string
  logger: Logger
  store: Store
  settings: SettingsStore
  secrets: Secrets
  accounts: AccountStore
  account: AccountService
  runner: Runner
  helpers: HelperManager
  scheduler: Scheduler
  memory: MemoryService
  apps: AppsService
  learned: LearnedStore
  /** The app contract, for the node server's /v1/rpc. */
  ipc: HandlerTable
  /** Replaced by the node server once it runs (device commands to the origin device). */
  actions: DeviceActions
  /** True while any chat has a turn running. */
  busy(): boolean
  /** Stop timers, wait for running turns (up to `graceMs`), close the database. */
  stop(graceMs?: number): Promise<void>
}

const NO_SCREEN = 'This device has no screen, so nothing was opened here.'

/** Browser tools stay in the list (so prompts and helpers keep their shape) but say plainly they are absent. */
function markNoBrowser(tools: Tool[]): Tool[] {
  return tools.map((tool) =>
    tool.spec.name.startsWith('browser_')
      ? { ...tool, spec: { ...tool.spec, description: `Not available on this device (no browser here). ${tool.spec.description}` } }
      : tool,
  )
}

export async function startHeadlessRuntime(options: HeadlessOptions): Promise<HeadlessRuntime> {
  const dir = options.dataDir
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const logger = new Logger(join(dir, 'logs'))
  const ipc = new HandlerTable()
  const broadcast = (channel: string, payload?: unknown): void => ipc.broadcast(channel, payload)

  const actions: DeviceActions = {
    openUrl: options.actions?.openUrl ?? ((url) => {
      logger.info('open_url with no screen', { host: safeHost(url) })
      return NO_SCREEN
    }),
    notify: options.actions?.notify ?? ((title) => logger.info('Notification', { title })),
  }

  const store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'))
  const secrets = new Secrets(join(dir, 'secrets'), new FileKeyCipher(join(dir, 'secrets.key')))
  migrateLegacyAccount(settings, secrets)
  const accounts = new AccountStore(settings, secrets)
  const brainLocks = new FileBrainLocks(join(dir, 'brain-locks.json'))
  const account = new AccountService(store, settings, secrets)
  const disposeStore = store.onChange(() => account.nudge())
  const filePicks = new Set<string>()

  const environment = hostEnvironment()
  if (options.quiet !== true) void environment.scan().catch(() => undefined)
  logger.info('Starting headless node', { version: options.version, platform: process.platform })

  const learned = new LearnedStore(join(dir, 'learned-apps.json'))
  const apps = new AppsService({
    secrets,
    file: new ConnectedAppsFile(join(dir, 'connected-apps.json')),
    learned,
    profiles: new ProfileStore(join(dir, 'profiles.json')),
    openExternal: async (url) => {
      await actions.openUrl(url)
    },
  })
  const learnedNames = (): Record<string, string> => Object.fromEntries(learned.apps().map((a) => [a.id, a.name]))

  const factory =
    options.providerFactory ??
    ((current: ReturnType<SettingsStore['get']>, key: string): ReturnType<typeof providerFor> =>
      providerFor({ provider: current.provider, key, baseUrl: current.baseUrl.trim() || undefined, allowHttp: current.allowHttp }))
  const budget = new StepBudget()
  const cliHost = new CliHost(join(dir, 'cli'), () => settings.get(), options.appDir)
  // Late-bound: the runner needs the tools, the tools need the helpers, the helpers deliver to the runner.
  let runner: Runner | null = null
  let memory: MemoryService | null = null
  const notify = (title: string, body: string): void => actions.notify(title, body)

  const helpers = new HelperManager({
    store,
    cli: cliHost,
    settings,
    secrets,
    providerFactory: factory,
    workerTools: markNoBrowser(buildWorkerToolset({ store, settings, agentName: () => settings.get().agentName, environment, apps, learned })),
    deliver: async (note, chat) => {
      if (runner !== null) await runner.deliver(note, chat)
    },
    alongsideDone: async (chat, helperId) => {
      if (runner !== null) await runner.alongsideDone(chat, helperId)
    },
    platform: process.platform,
    emit: (event) => broadcast(EVENTS.chat, event),
    notify,
    profiles: apps.profiles,
    learnedNames,
  })
  const tools = markNoBrowser([
    ...buildToolset({
      store,
      settings,
      filePicks,
      agentName: () => settings.get().agentName,
      helpers,
      mainBudget: budget,
      environment,
      apps,
      learned,
      searchChats: async (query, limit) => (memory === null ? [] : memory.searchChats(query, limit)),
      projects: {
        post: async (chat, text, via) => {
          if (runner !== null) await runner.receive(chat, text, via)
        },
        state: (chat) => runner?.state(chat) ?? { running: false, waiting: [] },
        agentName: () => settings.get().agentName,
        profiles: () => apps.profiles.all(),
        accounts: () => accounts.all(),
        open: (projectId) => broadcast(EVENTS.route, { view: 'project', id: projectId }),
        // No image library without Electron: a picture icon falls back to the glyph.
        imageIcon: async () => null,
      },
    }),
    ...(options.extraTools ?? []),
  ])
  const theRunner = new Runner({
    store,
    settings,
    secrets,
    tools,
    helpers,
    cli: cliHost,
    openUrl: (url) => {
      void actions.openUrl(url)
    },
    budget,
    locks: brainLocks,
    profiles: () => ({ profiles: apps.profiles.all(), learnedNames: learnedNames() }),
    environment: () => environment.current(),
    providerFactory: factory,
    notify,
    notifyCard: (_itemId, title, body) => notify(title, body),
    emit: (event) => broadcast(EVENTS.chat, event),
    // Nobody is looking at a server: every card that needs the person may notify.
    isFocused: () => false,
    allowFiles: (paths) => {
      for (const path of paths) filePicks.add(path)
    },
  })
  runner = theRunner

  try {
    await adoptEarlierChats(store, store.deletedIds('project').has(EARLIER_CHATS_PROJECT))
  } catch {
    // The chats are still in the store; they are adopted on a later start.
  }
  try {
    await theRunner.restore()
  } catch {
    // Startup repair is best effort.
  }

  const chatIndex = new ChatIndex(join(dir, 'chat-search.db'))
  const upkeep = new UpkeepFile(join(dir, 'memory-upkeep.json'))
  try {
    await ensureDailyRoutine(store, {
      dailyAt: settings.get().dailyMemoryAt,
      lastReport: upkeep.read().report,
      deleted: store.deletedIds('trigger').has(MEMORY_DAILY_ROUTINE),
    })
  } catch {
    // Without the row the pass simply does not run on its own.
  }
  const complete = (system: string, prompt: string, signal?: AbortSignal): Promise<string> =>
    theRunner.oneShot(system, prompt, signal)
  const theMemory = new MemoryService({
    store,
    index: chatIndex,
    upkeep,
    complete,
    forgetSession: (thread) => cliHost.forget(thread),
    emitChat: () => broadcast(EVENTS.chat, { type: 'chat_changed' }),
    dailyAt: () => dailyRoutineSlot(store),
    onDaily: (report) => recordDailyRun(store, report),
    log: (message, detail) => logger.info(message, detail),
  })
  memory = theMemory
  const memoryTidy = new MemoryTidy({
    store,
    complete,
    upkeep,
    file: new TidyFile(join(dir, 'memory-tidy.json')),
    log: (message, detail) => logger.info(message, detail),
  })
  registerMemoryIpc({ ipcMain: ipc, service: theMemory, store, log: (message, detail) => logger.info(message, detail), tidy: memoryTidy })
  registerMemoryHistoryIpc(ipc, store)
  if (options.quiet !== true) {
    void theMemory.restore().catch(() => undefined)
    theMemory.start()
  }

  const scheduler = new Scheduler({
    store,
    runner: theRunner,
    notifyRoutine: (_triggerId, name, result) => {
      notify(`Routine finished: ${name}`, result)
      return true
    },
    runBuiltin: async (trigger) => {
      if (trigger.builtin !== MEMORY_DAILY_ROUTINE) throw new Error('That routine cannot run here.')
      return { text: resultLine(await theMemory.runNow()), waiting: false }
    },
  })
  if (options.quiet !== true) scheduler.start()

  const disposeIpc = registerIpc({
    store,
    settings,
    secrets,
    accounts,
    account,
    chat: theRunner,
    routines: scheduler,
    helpers,
    ipcMain: ipc,
    windows: { minimize: () => undefined, toggleMaximize: () => undefined, close: () => undefined, isMaximized: () => false },
    broadcast,
    shell: {
      openExternal: async (url) => {
        await actions.openUrl(url)
      },
      showItemInFolder: () => undefined,
    },
    environment,
    apps,
    pasted: {
      save: async (name, mime, bytes) => {
        const saved = savePastedFile(join(dir, 'attachments'), name, mime, bytes)
        filePicks.add(saved.path)
        return saved
      },
      clipboardFiles: async () => [],
    },
    systemInfo: { platform: process.platform, arch: process.arch, hostname: osHostname(), appVersion: options.version },
  })

  const busy = (): boolean => theRunner.state().running
  let stopped = false

  return {
    dataDir: dir,
    logger,
    store,
    settings,
    secrets,
    accounts,
    account,
    runner: theRunner,
    helpers,
    scheduler,
    memory: theMemory,
    apps,
    learned,
    ipc,
    actions,
    busy,
    async stop(graceMs = 20_000): Promise<void> {
      if (stopped) return
      stopped = true
      scheduler.stop()
      theMemory.stop()
      // Let a running turn finish; if it does not in time it is marked interrupted on the next start and resumed.
      const deadline = Date.now() + graceMs
      while (busy() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200))
      logger.info('Stopping headless node', { turnStillRunning: busy() ? 1 : 0 })
      disposeIpc()
      disposeStore()
      theRunner.dispose()
      account.dispose()
      chatIndex.close()
      store.close()
    },
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
