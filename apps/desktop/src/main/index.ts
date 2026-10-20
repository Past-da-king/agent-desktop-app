import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { basename, join } from 'node:path'

import {
  app,
  BrowserWindow,
  Notification,
  dialog,
  globalShortcut,
  ipcMain,
  powerMonitor,
  safeStorage,
  shell,
  type OpenDialogOptions,
} from 'electron'

import type { AppPlatform } from '@agent/core'

import { mimeForFile, providerFor, type Attachment, type Settings } from '@agent/core'

import { registerIpc, type DialogLike, type WindowControls } from './ipc'
import { AccountService } from './account'
import { APP_ID, APP_NAME, LICENCES_URL, makeAppInfo, windowTitle } from './app-info'
import { AgentBrowser } from './browser/browser'
import { Store } from './db'
import { Logger } from './logger'
import { Notifier } from './notify'
import { HotkeyBinder, QuickAskWindow, quickAskPaths, type HotkeyStatus } from './hotkey'
import { StepBudget } from './runtime/budget'
import { hostEnvironment } from './runtime/environment-host'
import { HelperManager } from './runtime/helpers'
import { Runner } from './runtime/runner'
import { Scheduler } from './runtime/scheduler'
import { buildToolset, buildWorkerToolset } from './runtime/toolset'
import { AppsService } from './apps/service'
import { ProfileStore } from './apps/profiles'
import { ConnectedAppsFile, LearnedStore } from './apps/store'
import { CliHost } from './runtime/cli-host'
import { Secrets } from './secrets'
import { SettingsStore } from './settings'
import { createTray, type TrayHandle } from './tray'
import { startUpdates } from './updates'
import { EVENTS } from '../shared/channels'
import { registerVoiceIpc } from './voice/ipc'
import { allowMicrophone } from './voice/permissions'
import { VoiceService } from './voice/service'

const isSmoke = process.argv.includes('--smoke')
const smokeTimeoutMs = 30_000

app.setName(APP_NAME)
// Set once, before any window or notification exists, so Windows shows toasts under the app's name.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

const logsDir = join(app.getPath('userData'), 'logs')
const logger = new Logger(logsDir)
let crashDialogOpen = false

function platformId(): AppPlatform {
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'darwin') return 'darwin'
  return 'linux'
}

function showCalmDialog(detail: string, offerRestart: boolean): void {
  if (!app.isReady() || crashDialogOpen) return
  crashDialogOpen = true
  const buttons = offerRestart ? ['Keep going', 'Restart'] : ['OK']
  void dialog
    .showMessageBox({
      type: 'error',
      title: APP_NAME,
      message: `${APP_NAME} hit an unexpected problem.`,
      detail,
      buttons,
      defaultId: 0,
      cancelId: 0,
    })
    .then(({ response }) => {
      crashDialogOpen = false
      if (offerRestart && response === 1) {
        app.relaunch()
        app.exit(1)
      }
    })
}

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { message: error.message, stack: error.stack })
  showCalmDialog('Your saved work is safe. You can keep going, or restart the app.', true)
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) })
})

interface WindowState {
  width: number
  height: number
  x: number | null
  y: number | null
  maximized: boolean
}

let mainWindow: BrowserWindow | null = null
let smokeTimer: NodeJS.Timeout | null = null
let store: Store | null = null
let settingsStore: SettingsStore | null = null
let account: AccountService | null = null
let runner: Runner | null = null
let voice: VoiceService | null = null
let cliHost: CliHost | null = null
let scheduler: Scheduler | null = null
let tray: TrayHandle | null = null
let quickAsk: QuickAskWindow | null = null
let hotkey: HotkeyBinder | null = null
let agentBrowser: AgentBrowser | null = null
let disposeIpc: (() => void) | null = null
let disposeStore: (() => void) | null = null
let disposeSettings: (() => void) | null = null

let quitting = false
let toldAboutTray = false
let routinesPaused = false
let appliedHotkey: string | null = null
let lastHotkeyStatus: HotkeyStatus | null = null
const filePicks = new Set<string>()

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body }).show()
}

function windowControls(): WindowControls {
  return {
    minimize: () => mainWindow?.minimize(),
    toggleMaximize: () => {
      if (!mainWindow) return
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    },
    close: () => mainWindow?.close(),
    isMaximized: () => mainWindow?.isMaximized() ?? false,
  }
}

function readWindowState(file: string): WindowState {
  const fallback: WindowState = { width: 1280, height: 820, x: null, y: null, maximized: false }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback
    const raw = parsed as Record<string, unknown>
    return {
      width: finiteInRange(raw['width'], 360, 10_000) ?? fallback.width,
      height: finiteInRange(raw['height'], 400, 10_000) ?? fallback.height,
      x: finiteInRange(raw['x'], -20_000, 20_000),
      y: finiteInRange(raw['y'], -20_000, 20_000),
      maximized: raw['maximized'] === true,
    }
  } catch {
    return fallback
  }
}

function writeWindowState(file: string, win: BrowserWindow): void {
  try {
    const bounds = win.getNormalBounds()
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
    }
    const temp = `${file}.tmp`
    writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(temp, file)
  } catch {
    // Remembering the window is a convenience; losing it must never stop the app closing.
  }
}

function finiteInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null
}

function watchMaximize(win: BrowserWindow): void {
  win.on('maximize', () => win.webContents.send(EVENTS.maximize, true))
  win.on('unmaximize', () => win.webContents.send(EVENTS.maximize, false))
}

function startSmokeCheck(win: BrowserWindow): void {
  const deadline = Date.now() + smokeTimeoutMs

  smokeTimer = setTimeout(() => {
    console.error('SMOKE FAILED: timed out waiting for window.agent')
    app.exit(1)
  }, smokeTimeoutMs)

  const check = async (): Promise<boolean> => {
    if (win.isDestroyed()) return false
    try {
      const ready = await win.webContents.executeJavaScript(
        `(async () => {
          if (typeof window.agent !== 'object' || window.agent === null) return false;
          try {
            const settings = await window.agent.settings.get();
            return typeof settings === 'object' && settings !== null;
          } catch {
            return false;
          }
        })()`,
      )
      return ready === true
    } catch {
      return false
    }
  }

  const browserCheck = async (): Promise<boolean> => {
    const browser = agentBrowser
    if (browser === null) return false
    const ok = await browser.smokeOutline(
      '<!doctype html><html><head><title>Smoke</title></head><body><h1>Smoke</h1><button>Save</button></body></html>',
    )
    if (!ok) {
      console.error('BROWSER FAILED: the outline helper did not see the data: page')
      app.exit(1)
    }
    if (ok) console.log('BROWSER OK')
    return ok
  }

  const poll = async (): Promise<void> => {
    while (Date.now() < deadline) {
      if ((await check()) && (await browserCheck())) {
        if (smokeTimer) clearTimeout(smokeTimer)
        smokeTimer = null
        console.log('SMOKE OK')
        app.exit(0)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  win.webContents.once('did-finish-load', () => {
    void poll()
  })
}

function createWindow(stateFile: string): BrowserWindow {
  const saved = readWindowState(stateFile)
  const win = new BrowserWindow({
    title: windowTitle(),
    width: saved.width,
    height: saved.height,
    ...(saved.x !== null && saved.y !== null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 360,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    // Windows 11 snap layouts and Aero snap keep working on a frameless window with a thick frame.
    thickFrame: true,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#FAF8F4',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow = win

  win.once('ready-to-show', () => {
    if (saved.maximized) win.maximize()
    win.show()
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.on('close', (event) => {
    writeWindowState(stateFile, win)
    const closeToTray = settingsStore?.get().closeToTray === true
    if (!quitting && closeToTray && tray !== null) {
      event.preventDefault()
      win.hide()
      if (!toldAboutTray) {
        toldAboutTray = true
        showNotification(
          'Agent is still running in the tray',
          'It keeps working in the background. Right-click the tray icon to quit.',
        )
      }
      return
    }
    agentBrowser?.detach()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  // The shortcut is registered before the renderer is ready, so a fresh window is told the result.
  win.webContents.on('did-finish-load', () => {
    if (lastHotkeyStatus !== null) win.webContents.send(EVENTS.hotkey, lastHotkeyStatus)
  })

  win.on('page-title-updated', (event) => {
    event.preventDefault()
    win.setTitle(windowTitle())
  })

  watchMaximize(win)

  let rendererReloaded = false
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process gone', { reason: details.reason, exitCode: details.exitCode })
    if (!rendererReloaded && !win.isDestroyed()) {
      rendererReloaded = true
      win.reload()
      return
    }
    showCalmDialog('The window stopped responding. Restart the app to carry on.', true)
  })

  if (isSmoke) startSmokeCheck(win)

  return win
}

function loadWindow(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function showMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    const next = createWindow(join(app.getPath('userData'), 'window-state.json'))
    agentBrowser?.attach(next)
    loadWindow(next)
    return
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function applyLoginItem(settings: Settings): void {
  try {
    // A packaged Windows app registers its own .exe; in development there is no installed program.
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      ...(app.isPackaged ? { path: app.getPath('exe') } : {}),
    })
  } catch {
    // Linux desktops and some managed machines refuse this; the setting simply has no effect there.
  }
}

function applyHotkey(settings: Settings): void {
  if (hotkey === null) return
  if (appliedHotkey === settings.quickAskHotkey) return
  appliedHotkey = settings.quickAskHotkey
  const status: HotkeyStatus = hotkey.apply(settings.quickAskHotkey)
  lastHotkeyStatus = status
  broadcast(EVENTS.hotkey, status)
}

function openQuickAsk(): void {
  quickAsk?.show()
}

function trayState(): { needsYou: number; routinesPaused: boolean } {
  return {
    needsYou: runner?.state().waiting.length ?? 0,
    routinesPaused,
  }
}

function createAppTray(): void {
  const iconName = process.platform === 'win32' ? 'tray-32.png' : 'tray-16.png'
  tray = createTray({
    iconPath: join(app.getAppPath(), 'resources', iconName),
    tooltip: APP_NAME,
    state: trayState,
    actions: {
      open: showMainWindow,
      quickAsk: openQuickAsk,
      showNeedsYou: showMainWindow,
      toggleRoutines: () => {
        routinesPaused = !routinesPaused
        tray?.refresh()
      },
      quit: () => app.quit(),
    },
    onError: (error) => {
      console.error('Tray could not be created:', error)
    },
  })
}

async function pickFilePaths(): Promise<string[]> {
  const options: OpenDialogOptions = {
    title: 'Choose files',
    properties: ['openFile', 'multiSelections'],
  }
  const result =
    mainWindow === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(mainWindow, options)
  return result.canceled ? [] : result.filePaths
}

async function pickOneFolder(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Choose a folder',
    properties: ['openDirectory', 'createDirectory'],
  }
  const result =
    mainWindow === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(mainWindow, options)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

const dialogs: DialogLike = {
  async pickFiles(): Promise<Attachment[]> {
    const paths = await pickFilePaths()
    return paths.map((path) => {
      let size: number | undefined
      try {
        size = statSync(path).size
      } catch {
        // A file that vanished between picking and reading it simply has no size.
      }
      return { path, name: basename(path), mime: mimeForFile(path), ...(size !== undefined ? { size } : {}) }
    })
  },
  pickFolder: pickOneFolder,
}

async function startServices(win: BrowserWindow): Promise<void> {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })

  store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'))
  settingsStore = settings
  const secrets = new Secrets(join(dir, 'secrets'), safeStorage)
  account = new AccountService(store, settings, secrets)
  disposeStore = store.onChange(() => account?.nudge())

  const notifier = new Notifier({
    supported: () => Notification.isSupported(),
    create: (options) => new Notification(options),
    isFocused: () => mainWindow?.isFocused() ?? false,
    enabled: () => settings.get().notifications,
    focus: () => {
      const win = mainWindow
      if (win === null) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    },
    route: (target) => broadcast(EVENTS.route, target),
  })

  const fromEnv = process.env['AGENT_SYNC_URL']?.trim() ?? ''
  if (settings.get().syncUrl.trim() === '' && fromEnv !== '') {
    settings.save({ syncUrl: fromEnv })
  }

  const environment = hostEnvironment()
  logger.info('Starting', { version: app.getVersion(), platform: platformId() })
  // Look at the computer in the background. It only runs `--version`; nothing is installed or sent.
  void environment.scan().catch(() => undefined)
  const updates = startUpdates()
  logger.info('Updates', { status: updates.status })

  agentBrowser = new AgentBrowser({
    window: win,
    onState: (state) => broadcast(EVENTS.browser, state),
    openExternal: (url) => shell.openExternal(url),
    sitesFile: join(app.getPath('userData'), 'browser-sites.json'),
  })
  // The real-Electron browser proof opens a local test page here; never set in normal use.
  const probeUrl = process.env['AGENT_BROWSER_PROBE_URL']?.trim() ?? ''
  if (probeUrl !== '') {
    setTimeout(() => {
      const browser = agentBrowser
      if (browser === null) return
      void (async () => {
        console.log(`BROWSER PROBE opened\n${await browser.probeOpen(probeUrl)}`)
        if (process.env['AGENT_BROWSER_PROBE_ACT'] !== '1') return
        // Trusted input by name, at desktop size and again at phone size (where the view is drawn scaled).
        console.log(`BROWSER PROBE click\n${await browser.act({ action: 'click', name: 'Press me' })}`)
        console.log(`BROWSER PROBE type\n${await browser.act({ action: 'type', name: 'Search here', text: 'hello world' })}`)
        console.log(`BROWSER PROBE eval\n${await browser.evaluate("({ button: document.getElementById('go').textContent, field: document.getElementById('q').value })", 10)}`)
        await browser.view({ mode: 'phone', remember: false })
        await browser.evaluate("document.getElementById('go').textContent = 'Press me'", 5)
        console.log(`BROWSER PROBE phone click\n${await browser.act({ action: 'click', name: 'Press me' })}`)
        console.log(`BROWSER PROBE phone eval\n${await browser.evaluate("({ button: document.getElementById('go').textContent, w: innerWidth, ts: window.__ts || 'none', pd: window.__pd || 'none', btn: JSON.stringify(document.getElementById('go').getBoundingClientRect()) })", 10)}`)
        await browser.view({ mode: 'desktop', remember: false })
        console.log('BROWSER PROBE done')
        const handoffMs = Number(process.env['AGENT_BROWSER_PROBE_HANDOFF_MS'] ?? '')
        if (Number.isFinite(handoffMs) && handoffMs > 0) {
          setTimeout(() => {
            browser.setAgentDriving(false, 'Sign in to the test page, then press Done, carry on.')
            console.log('BROWSER PROBE handoff')
          }, handoffMs)
        }
      })()
    }, 2500)
  }

  const learned = new LearnedStore(join(dir, 'learned-apps.json'))
  const apps = new AppsService({
    secrets,
    file: new ConnectedAppsFile(join(dir, 'connected-apps.json')),
    learned,
    // Profiles stay on this computer (not a synced entity yet).
    profiles: new ProfileStore(join(dir, 'profiles.json')),
    openExternal: (url) => shell.openExternal(url),
  })
  const learnedNames = (): Record<string, string> => Object.fromEntries(learned.apps().map((a) => [a.id, a.name]))

  const factory = (current: ReturnType<SettingsStore['get']>, key: string): ReturnType<typeof providerFor> =>
    providerFor({
      provider: current.provider,
      key,
      baseUrl: current.baseUrl.trim() || undefined,
      allowHttp: current.allowHttp,
    })
  const budget = new StepBudget()
  // Runs on the person's own plan (Claude Agent SDK / Codex SDK): the main agent and every helper.
  cliHost = new CliHost(join(app.getPath('userData'), 'cli'), () => settings.get(), app.getAppPath())
  const helpers = new HelperManager({
    store,
    cli: cliHost,
    settings,
    secrets,
    providerFactory: factory,
    workerTools: buildWorkerToolset({
      store,
      settings,
      browser: agentBrowser,
      agentName: () => settings.get().agentName,
      environment,
      apps,
      learned,
    }),
    deliver: async (note) => {
      if (runner !== null) await runner.deliver(note)
    },
    platform: process.platform,
    emit: (event) => broadcast(EVENTS.chat, event),
    notify: showNotification,
    profiles: apps.profiles,
    learnedNames,
  })
  const tools = buildToolset({
    store,
    settings,
    filePicks,
    pickFiles: pickFilePaths,
    browser: agentBrowser,
    agentName: () => settings.get().agentName,
    helpers,
    mainBudget: budget,
    environment,
    apps,
    learned,
    voiceNotes: () => (voice !== null && voice.hasKey() ? voice : null),
  })
  runner = new Runner({
    store,
    settings,
    secrets,
    tools,
    helpers,
    cli: cliHost,
    openUrl: (url) => {
      void shell.openExternal(url)
    },
    budget,
    profiles: () => ({ profiles: apps.profiles.all(), learnedNames: learnedNames() }),
    environment: () => environment.current(),
    providerFactory: factory,
    notify: showNotification,
    notifyCard: (itemId, title, body) => notifier.needsYou(itemId, title, body),
    emit: (event) => {
      broadcast(EVENTS.chat, event)
      tray?.refresh()
    },
    isFocused: () => mainWindow?.isFocused() ?? false,
  })
  try {
    await runner.restore()
  } catch {
    // Startup repair is best effort: the app must still open if a row cannot be rewritten.
  }

  scheduler = new Scheduler({
    store,
    runner,
    notifyRoutine: (triggerId, name, result) => notifier.routineResult(triggerId, name, result),
  })
  scheduler.start()

  const paths = quickAskPaths(__dirname)
  quickAsk = new QuickAskWindow({
    ...paths,
    devUrl: process.env['ELECTRON_RENDERER_URL'],
  })
  hotkey = new HotkeyBinder(globalShortcut, openQuickAsk, (status) => {
    lastHotkeyStatus = status
    broadcast(EVENTS.hotkey, status)
  })

  let lastSettings = settings.get()
  disposeSettings = settings.onChange((next) => {
    // Which settings changed (names only, never values), so a setting that will not stick can be traced.
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(lastSettings[key]))
    lastSettings = next
    if (changed.length > 0) logger.info('Settings changed', { keys: changed.join(',') })
    applyLoginItem(next)
    applyHotkey(next)
    tray?.refresh()
  })

  disposeIpc = registerIpc({
    store,
    settings,
    secrets,
    account,
    chat: runner,
    routines: scheduler,
    helpers,
    ipcMain,
    windows: windowControls(),
    browser: agentBrowser,
    broadcast,
    shell: {
      openExternal: (url) => shell.openExternal(url),
      showItemInFolder: (path) => shell.showItemInFolder(path),
    },
    dialogs,
    environment,
    apps,
    systemInfo: {
      platform: process.platform,
      arch: process.arch,
      hostname: osHostname(),
      appVersion: app.getVersion(),
    },
    appInfo: () =>
      makeAppInfo({
        version: app.getVersion(),
        platform: platformId(),
        electron: process.versions.electron ?? '',
        logsPath: logsDir,
      }),
    openLogsFolder: async () => {
      mkdirSync(logsDir, { recursive: true })
      await shell.openPath(logsDir)
    },
    openLicences: async () => {
      await shell.openExternal(LICENCES_URL)
    },
  })

  // Voice: the Gemini key and the live call stay here; the window only streams microphone audio.
  allowMicrophone(win.webContents.session, (id) => id === win.webContents.id)
  voice = new VoiceService({
    secrets,
    settings,
    store,
    runner,
    emit: (event) => broadcast(EVENTS.voiceCall, event),
    platform: process.platform,
    environment: () => environment.current(),
    notesDir: join(app.getPath('userData'), 'voice-notes'),
  })
  registerVoiceIpc(voice, ipcMain)

  applyLoginItem(settings.get())
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    const win = createWindow(join(app.getPath('userData'), 'window-state.json'))
    await startServices(win)
    loadWindow(win)
    powerMonitor.on('resume', () => {
      void scheduler?.resume()
    })
    createAppTray()
    const current = settingsStore?.get()
    if (current !== undefined) applyHotkey(current)
    tray?.refresh()

    app.on('activate', () => {
      showMainWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    disposeIpc?.()
    disposeIpc = null
    disposeSettings?.()
    disposeSettings = null
    disposeStore?.()
    disposeStore = null
    scheduler?.stop()
    scheduler = null
    tray?.destroy()
    tray = null
    quickAsk?.destroy()
    quickAsk = null
    hotkey?.dispose()
    hotkey = null
    globalShortcut.unregisterAll()
    void voice?.callEnd()
    voice = null
    runner?.dispose()
    runner = null
    agentBrowser?.destroy()
    agentBrowser = null
    account?.dispose()
    account = null
    store?.close()
    store = null
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
