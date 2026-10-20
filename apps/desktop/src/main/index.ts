import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, shell } from 'electron'

const isSmoke = process.argv.includes('--smoke')
const smokeTimeoutMs = 20_000

let mainWindow: BrowserWindow | null = null
let smokeTimer: NodeJS.Timeout | null = null

function registerWindowIpc(): void {
  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })

  ipcMain.on('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
}

function watchMaximize(win: BrowserWindow): void {
  win.on('maximize', () => {
    win.webContents.send('window:maximize-changed', true)
  })
  win.on('unmaximize', () => {
    win.webContents.send('window:maximize-changed', false)
  })
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
      const present = await win.webContents.executeJavaScript(
        'typeof window.agent === "object" && window.agent !== null',
      )
      return present === true
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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
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
    win.show()
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
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

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    registerWindowIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
