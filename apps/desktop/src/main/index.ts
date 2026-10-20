import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'

import { registerIpc, type WindowControls } from './ipc'
import { AccountService } from './account'
import { Store } from './db'
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
let disposeIpc: (() => void) | null = null

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
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

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function startServices(): void {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })

  const openedStore = new Store(join(dir, 'agent.db'))
  store = openedStore
  const settings = new SettingsStore(join(dir, 'settings.json'))
  const secrets = new Secrets(join(dir, 'secrets'), safeStorage)
  account = new AccountService(openedStore, settings, secrets, {
    countRows: async (entity) => (await openedStore.list(entity)).length,
  })

  const fromEnv = process.env['AGENT_SYNC_URL']?.trim() ?? ''
  if (settings.get().syncUrl.trim() === '' && fromEnv !== '') {
    settings.save({ syncUrl: fromEnv })
  }

  disposeIpc = registerIpc({
    store,
    settings,
    secrets,
    account,
    ipcMain,
    windows: windowControls(),
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

  app.whenReady().then(() => {
    startServices()
    createWindow(join(app.getPath('userData'), 'window-state.json'))

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(join(app.getPath('userData'), 'window-state.json'))
      }
    })
  })

  app.on('before-quit', () => {
    disposeIpc?.()
    disposeIpc = null
    account?.dispose()
    account = null
    store?.close()
    store = null
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
