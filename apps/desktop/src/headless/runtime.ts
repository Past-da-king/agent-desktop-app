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
import { HandlerRegistry, recordHandlers } from '../main/devices/registry'
import { devicesState, ownBrainIds, type DevicesSyncDeps } from '../main/devices/sync'
import { TurnLeases } from '../main/runtime/turns'
import { registerWorkersIpc } from '../main/workers/ipc'
import { registerVoiceIpc } from '../main/voice/ipc'
import { HelperFeed } from '../main/devices/helper-feed'
import { VoiceService } from '../main/voice/service'
import { EventRouter } from '../main/workers/router'
import { killLeftover, killTree, spawnWorker } from '../main/workers/spawn'
import { WorkerStore } from '../main/workers/store'
import { Supervisor } from '../main/workers/supervisor'
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
import { ProjectAgentRows } from '../main/runtime/project-agents'
import { Scheduler } from '../main/runtime/scheduler'
import { buildToolset, buildWorkerToolset } from '../main/runtime/toolset'
import { Secrets } from '../main/secrets'
import { SettingsStore } from '../main/settings'
import { EVENTS } from '../shared/channels'
import { WORKER_EVENTS } from '../shared/workers-channels'

const WORKERS_CHANGED = WORKER_EVENTS.changed
import { loadIdentity } from '../main/devices/identity'
import { findChromium, HeadlessBrowser } from './browser'
import { headlessFacts } from './devices'
import { readConfig } from './node-config'
import { relayTool, type RelayTarget } from './relay-tool'
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
  /** Use this Chromium for the browser tools; null for none. Default: whatever findChromium() finds. */
  chromium?: string | null
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
  /** Turn leases: a turn or helper cut off by a crash or a restart resumes, and failover between brains. */
  leases: TurnLeases
  /** What devices/attach.ts needs from the runtime (shared tools, notes back to a chat, cards for other brains). */
  devicesHooks: Pick<DevicesSyncDeps, 'leases' | 'localTools' | 'shareGroups' | 'preferred' | 'noteBack' | 'context'>
  /** The per-account rules file, for the devices bundle. */
  connectedApps: ConnectedAppsFile
  /** Background workers (agent-written scripts kept running) and the router that hands their events to routines. */
  supervisor: Supervisor
  /** The main agent's toolset: what this node lends to the agents on other devices (shared device tools, s11). */
  mainTools: Tool[]
  /** The node's own headless browser, or null when this machine has no Chromium. */
  browser: HeadlessBrowser | null
  /** The app contract by channel, for tests and local calls. */
  ipc: HandlerTable
  /** The same handlers in the devices registry, so the node server serves them over /v1/rpc (devices/rpc.ts). */
  registry: HandlerRegistry
  /** Where more handlers register (Settings > Devices channels): recorded in both. */
  ipcMain: IpcMainLike
  /** Replaced by the node server once it runs (device commands to the origin device). */
  actions: DeviceActions
  /** True while any chat has a turn running. */
  busy(): boolean
  /** Run this first when the runtime stops (the devices sync). */
  onStop(fn: () => void | Promise<void>): void
  /** Stop timers, wait for running turns and helpers (up to `graceMs`), close the database. */
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
  const registry = new HandlerRegistry()
  const ipcMain = recordHandlers(ipc, registry)
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
  const connectedApps = new ConnectedAppsFile(join(dir, 'connected-apps.json'))
  const apps = new AppsService({
    secrets,
    file: connectedApps,
    learned,
    profiles: new ProfileStore(join(dir, 'profiles.json')),
    openExternal: async (url) => {
      await actions.openUrl(url)
    },
  })
  const learnedNames = (): Record<string, string> => Object.fromEntries(learned.apps().map((a) => [a.id, a.name]))
  const chromium = options.chromium === undefined ? findChromium() : options.chromium
  const browser = chromium === null
    ? null
    : new HeadlessBrowser({ dir: join(dir, 'browser'), executable: chromium, log: (message, detail) => logger.info(message, detail) })
  logger.info('Browser', { available: browser === null ? 0 : 1 })
  // With a browser the tools are the desktop's own; without one they stay listed and say so.
  const browserTools = (tools: Tool[]): Tool[] => (browser === null ? markNoBrowser(tools) : tools)
  const browserDep = browser === null ? {} : { browser }

  // Fetching through the person's other computers (relay.fetch on them), for sites that block this server.
  const devicesDir = join(dir, 'devices')
  let selfId = ''
  const relay = relayTool({
    secrets,
    selfId: () => (selfId ||= loadIdentity(devicesDir).nodeId),
    facts: () => {
      const identity = loadIdentity(devicesDir)
      return headlessFacts(readConfig(dir).name, options.version, readConfig(dir).publicUrls, identity.fp)
    },
    targets: async () => {
      const rows = (await store.list('device')).filter((row) => !row.revoked && (row.roles.includes('brain') || row.roles.includes('hands')))
      const found: Array<RelayTarget & { priority: number }> = rows.map((row) => ({ id: row.id, name: row.name, urls: row.urls, fp: row.fp, priority: row.priority }))
      for (const brain of readConfig(dir).brains) if (!found.some((t) => t.id === brain.id)) found.push(brain)
      return found.sort((a, b) => a.priority - b.priority)
    },
  })
  const nodeTools = [relay, ...(options.extraTools ?? [])]

  const factory =
    options.providerFactory ??
    ((current: ReturnType<SettingsStore['get']>, key: string): ReturnType<typeof providerFor> =>
      providerFor({ provider: current.provider, key, baseUrl: current.baseUrl.trim() || undefined, allowHttp: current.allowHttp }))
  const budget = new StepBudget()
  const cliHost = new CliHost(join(dir, 'cli'), () => settings.get(), options.appDir)
  // Late-bound: the runner needs the tools, the tools need the helpers, the helpers deliver to the runner.
  let runner: Runner | null = null
  // A project agent the main agent hands work to shows as a helper row in the main chat, with the project's icon.
  const projectAgents = new ProjectAgentRows({
    store,
    state: (chat) => runner?.state(chat) ?? { running: false, waiting: [] },
    changed: () => broadcast(EVENTS.chat, { type: 'chat_changed' }),
  })
  let memory: MemoryService | null = null
  const notify = (title: string, body: string): void => actions.notify(title, body)

  // Background workers (docs/workers-and-triggers.md): a server is a good home for them. Their events go to the
  // router, which hands them to each event routine's desk.
  const workers = new WorkerStore(join(dir, 'workers'))
  let eventRouter: EventRouter | null = null
  const workerNotice = async (text: string): Promise<void> => {
    try {
      await store.upsert('chat_item', { kind: 'notice', text, meta: JSON.stringify({ workers: true }) })
      broadcast(EVENTS.chat, { type: 'chat_changed' })
    } catch {
      // The log and the notification still have it.
    }
  }
  const supervisor = new Supervisor({
    store: workers,
    spawn: spawnWorker,
    secrets,
    killTree,
    killLeftover,
    onEvent: (event) => {
      void eventRouter?.offer(event)
    },
    onFailing: (worker) => {
      logger.warn('Worker failing', { id: worker.id })
      notify(`${worker.name} keeps failing`, worker.lastError || 'It stopped too often.')
      void workerNotice(`Worker "${worker.name}" keeps failing and was stopped: ${worker.lastError || 'it exited too often'}. Restart it on the Routines page, Workers.`)
    },
    onChange: () => broadcast(WORKERS_CHANGED, null),
  })
  const workerDeps = { store: workers, supervisor }
  const leases = new TurnLeases({
    store,
    selfId: () => devicesState.sync?.selfId() ?? store.deviceId,
    ownIds: () => ownBrainIds(store),
    resumeTurn: (chat, id, note) => runner?.resumeTurn(chat, id, note),
    resumeJob: async (id, note) => {
      await helpers.push(id, note)
    },
    lost: (lease) => {
      if (lease.kind === 'job') void helpers.stop(lease.messageId)
      else runner?.stop(lease.chatId)
    },
  })
  const deviceHub = (): NonNullable<typeof devicesState.sync>['tools'] | null => devicesState.sync?.tools ?? null
  const workerToolList = [...browserTools(buildWorkerToolset({ store, settings, ...browserDep, deviceHub, agentName: () => settings.get().agentName, environment, apps, learned, workers: workerDeps })), ...nodeTools]
  const helpers = new HelperManager({
    leases,
    store,
    cli: cliHost,
    settings,
    secrets,
    providerFactory: factory,
    workerTools: workerToolList,
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
  const tools = browserTools([
    ...buildToolset({
      store,
      settings,
      ...browserDep,
      filePicks,
      agentName: () => settings.get().agentName,
      helpers,
      mainBudget: budget,
      environment,
      apps,
      learned,
      searchChats: async (query, limit) => (memory === null ? [] : memory.searchChats(query, limit)),
      deviceHub,
      workers: workerDeps,
      devices: {
        selfId: () => devicesState.sync?.selfId() ?? '',
        commands: () => devicesState.sync?.commands ?? null,
        // No screen here: a link the person should see goes to the device they asked from (device commands).
        openLocal: (url) => {
          void actions.openUrl(url)
        },
      },
      projects: {
        agents: projectAgents,
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
    ...nodeTools,
  ])
  eventRouter = new EventRouter({
    store,
    workers,
    desk: helpers,
    onChange: () => broadcast(WORKERS_CHANGED, null),
    workerName: (id) => {
      try {
        return workers.manifest(id)?.name ?? id
      } catch {
        return id
      }
    },
    onFailed: (trigger, why) => {
      notify(`Routine could not run: ${trigger.name}`, why.slice(0, 200))
      void workerNotice(`Routine "${trigger.name}" could not hand its events to its desk: ${why.slice(0, 300)}. Its events are kept as failed; Run now on the Routines page tries them again.`)
    },
  })
  const router = eventRouter
  const theRunner = new Runner({
    devices: {
      leases,
      selfOrigin: () => devicesState.sync?.selfOrigin() ?? null,
      originLine: async (chat) => (await devicesState.sync?.originLine(chat)) ?? '',
    },
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
  // What a crash or a restart cut off runs again, once (runtime/turns.ts). With Devices on, the failover side is set
  // by devices/attach.ts and the recovery waits for one replication pass first.
  // Leases are recovered once the node's Devices side is up (headless/devices.ts), so the turns it ran under its
  // device id are found as its own and a peer's takeover is seen first.
  void projectAgents.restore().catch(() => undefined)
  // Events that arrived while the node was down (or were cut short) go to their routines now.
  if (options.quiet !== true) await router.start().catch((error: unknown) => logger.warn('Event router did not start', { message: error instanceof Error ? error.message : String(error) }))

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
  registerMemoryIpc({ ipcMain, service: theMemory, store, log: (message, detail) => logger.info(message, detail), tidy: memoryTidy })
  registerMemoryHistoryIpc(ipcMain, store)
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
    runEvent: async (trigger) => router.runNow(trigger),
  })
  if (options.quiet !== true) {
    scheduler.start()
    // Workers come back on every start; each catches up from its cursor on what it missed.
    supervisor.start()
  }
  registerWorkersIpc(ipcMain, { store: workers, supervisor, openPath: async () => '' })

  // Voice: a paired phone with no Google key of its own gets a one-use Live token from the key the bundle brought
  // here, and its call lands in this chat. Live calls held on this node itself need a screen, so none start here.
  const voice = new VoiceService({
    secrets,
    settings,
    store,
    runner: theRunner,
    emit: (event) => broadcast(EVENTS.voiceCall, event),
    platform: process.platform,
    notesDir: join(dir, 'voice-notes'),
  })
  // A linked phone's call hands its work to the main agent, a project chat or a helper here (main/voice/handoff.ts).
  const callStore = store
  const callRunner = theRunner
  const callHelpers = helpers
  const callFeed = new HelperFeed({ store: callStore, emit: () => undefined })
  registerVoiceIpc(voice, ipcMain, {
    store: callStore,
    send: (text, chat, origin) => callRunner.send(text, [], chat, origin as never),
    steer: (id, message) => callHelpers.steer(id, message),
    cards: () => callFeed.snapshot(),
    state: (chat) => callRunner.state(chat),
    agentName: () => settings.get().agentName,
    delegated: (chat, project, brief) => projectAgents.delegated(chat, project, brief),
  })

  const disposeIpc = registerIpc({
    store,
    settings,
    secrets,
    accounts,
    account,
    chat: theRunner,
    routines: scheduler,
    helpers,
    ipcMain,
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
  const stopHooks: Array<() => void | Promise<void>> = []

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
    browser,
    mainTools: tools,
    supervisor,
    leases,
    devicesHooks: {
      leases,
      localTools: () => workerToolList,
      shareGroups: () => settings.get().devicesShareGroups,
      preferred: () => settings.get().devicesPreferred,
      noteBack: async (chat, text) => {
        await theRunner.deliver(text, chat)
      },
      context: (chat, signal) => theRunner.deviceContext(chat, signal),
    },
    connectedApps,
    ipc,
    registry,
    ipcMain,
    actions,
    busy,
    onStop: (fn) => {
      stopHooks.push(fn)
    },
    async stop(graceMs = 20_000): Promise<void> {
      if (stopped) return
      stopped = true
      for (const fn of stopHooks.splice(0)) await Promise.resolve(fn()).catch(() => undefined)
      scheduler.stop()
      theMemory.stop()
      router.stop()
      supervisor.stopAll()
      // Let a running turn finish; if it does not in time it is marked interrupted on the next start and resumed.
      const deadline = Date.now() + graceMs
      const working = (): boolean => busy() || helpers.live().length > 0
      while (working() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200))
      logger.info('Stopping headless node', { stillWorking: working() ? 1 : 0 })
      await browser?.close()
      leases.stop()
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
