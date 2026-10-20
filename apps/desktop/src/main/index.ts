import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, BrowserWindow, Notification, ipcMain, safeStorage, shell } from 'electron'

import { providerFor } from '@agent/core'

import { registerIpc, type WindowControls } from './ipc'
import { AccountService } from './account'
import { AgentBrowser } from './browser/browser'
import { Store } from './db'
import { Runner } from './runtime/runner'
import { buildToolset } from './runtime/toolset'
import { Secrets } from './secrets'
import { SettingsStore } from './settings'
import { EVENTS } from '../shared/channels'

const isSmoke = process.argv.includes('--smoke')
const smokeTimeoutMs = 30_000

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
let account: AccountService | null = null
let runner: Runner | null = null
let agentBrowser: AgentBrowser | null = null
let disposeIpc: (() => void) | null = null
let disposeStore: (() => void) | null = null

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
    width: saved.width,
    height: saved.height,
    ...(saved.x !== null && saved.y !== null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 360,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
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

  win.on('close', () => {
    writeWindowState(stateFile, win)
    agentBrowser?.detach()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  watchMaximize(win)

  if (isSmoke) startSmokeCheck(win)

  return win
}

function loadWindow(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

async function startServices(win: BrowserWindow): Promise<void> {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })

  store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'))
  const secrets = new Secrets(join(dir, 'secrets'), safeStorage)
  account = new AccountService(store, settings, secrets)
  disposeStore = store.onChange(() => account?.nudge())

  const fromEnv = process.env['AGENT_SYNC_URL']?.trim() ?? ''
  if (settings.get().syncUrl.trim() === '' && fromEnv !== '') {
    settings.save({ syncUrl: fromEnv })
  }

  agentBrowser = new AgentBrowser({
    window: win,
    onState: (state) => broadcast(EVENTS.browser, state),
    openExternal: (url) => shell.openExternal(url),
  })

  const tools = buildToolset({
    store,
    browser: agentBrowser,
    agentName: () => settings.get().agentName,
  })
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
    emit: (event) => broadcast(EVENTS.chat, event),
    isFocused: () => mainWindow?.isFocused() ?? false,
  })
  try {
    await runner.restore()
  } catch {
    // Startup repair is best effort: the app must still open if a row cannot be rewritten.
  }

  disposeIpc = registerIpc({
    store,
    settings,
    secrets,
    account,
    chat: runner,
    ipcMain,
    windows: windowControls(),
    browser: agentBrowser,
    broadcast,
    shell: {
      openExternal: (url) => shell.openExternal(url),
      showItemInFolder: (path) => shell.showItemInFolder(path),
    },
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    const win = createWindow(join(app.getPath('userData'), 'window-state.json'))
    await startServices(win)
    loadWindow(win)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const next = createWindow(join(app.getPath('userData'), 'window-state.json'))
        agentBrowser?.attach(next)
        loadWindow(next)
      }
    })
  })

  app.on('before-quit', () => {
    disposeIpc?.()
    disposeIpc = null
    disposeStore?.()
    disposeStore = null
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
