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

import { mimeForFile, providerFor, type Attachment, type Settings } from '@agent/core'

import { registerIpc, type DialogLike, type WindowControls } from './ipc'
import { AccountService } from './account'
import { Store } from './db'
import { Notifier } from './notify'
import { HotkeyBinder, QuickAskWindow, quickAskPaths, type HotkeyStatus } from './hotkey'
import { Runner } from './runtime/runner'
import { Scheduler } from './runtime/scheduler'
import { buildToolset } from './runtime/toolset'
import { Secrets } from './secrets'
import { SettingsStore } from './settings'
import { createTray, type TrayHandle } from './tray'
import { EVENTS } from '../shared/channels'

const isSmoke = process.argv.includes('--smoke')
const smokeTimeoutMs = 30_000
const APP_NAME = 'Agent'

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
let scheduler: Scheduler | null = null
let tray: TrayHandle | null = null
let quickAsk: QuickAskWindow | null = null
let hotkey: HotkeyBinder | null = null
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

  const poll = async (): Promise<void> => {
    while (Date.now() < deadline) {
      if (await check()) {
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

function createWindow(stateFile: string): void {
  const saved = readWindowState(stateFile)
  const win = new BrowserWindow({
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
    }
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

  watchMaximize(win)

  if (isSmoke) startSmokeCheck(win)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function showMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    createWindow(join(app.getPath('userData'), 'window-state.json'))
    return
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function applyLoginItem(settings: Settings): void {
  try {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
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

async function startServices(): Promise<void> {
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

  const tools = buildToolset({ store, settings, filePicks, pickFiles: pickFilePaths })
  runner = new Runner({
    store,
    settings,
    secrets,
    tools,
    providerFactory: (current, key) =>
      providerFor({
        provider: current.provider,
        key,
        baseUrl: current.baseUrl.trim() || undefined,
        allowHttp: current.allowHttp,
      }),
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

  disposeSettings = settings.onChange((next) => {
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
    ipcMain,
    windows: windowControls(),
    broadcast,
    shell: {
      openExternal: (url) => shell.openExternal(url),
      showItemInFolder: (path) => shell.showItemInFolder(path),
    },
    dialogs,
    systemInfo: {
      platform: process.platform,
      arch: process.arch,
      hostname: osHostname(),
      appVersion: app.getVersion(),
    },
  })

  applyLoginItem(settings.get())
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    await startServices()
    createWindow(join(app.getPath('userData'), 'window-state.json'))
    powerMonitor.on('resume', () => {
      void scheduler?.resume()
    })
    createAppTray()
    const current = settingsStore?.get()
    if (current !== undefined) applyHotkey(current)
    tray?.refresh()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) showMainWindow()
      else showMainWindow()
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
    runner?.dispose()
    runner = null
    account?.dispose()
    account = null
    store?.close()
    store = null
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
