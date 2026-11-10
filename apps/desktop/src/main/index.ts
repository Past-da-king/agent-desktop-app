import { createWorkersChanged } from './workers/changed'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { basename, join } from 'node:path'

import {
  app,
  BrowserWindow,
  clipboard,
  Notification,
  dialog,
  globalShortcut,
  ipcMain as electronIpcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  type OpenDialogOptions,
  type Rectangle,
  session as electronSession,
} from 'electron'
import {
  fitWindowToDisplay,
  frameDelta,
  looksSnapped,
  sameRect,
  withoutFrame,
  workAreasPrimaryFirst,
  type FrameDelta,
} from './window-fit'
import { brandLook } from '../shared/brand'
import { guidesUseOverlay } from '../shared/capture-privacy'
import { CapturePrivacy } from './capture-privacy'
import { createGuideOverlay } from './overlay/overlay-window'
import { ICON_IMAGE_PX } from '../shared/project-icon'
import { AccountStore, migrateLegacyAccount } from './accounts'
import { FileBrainLocks } from './brain-locks'
import { HANDOFF_CLOSED } from './tools/browser'

import type { AppPlatform } from '@agent/core'

import { DEFAULT_SETTINGS, EARLIER_CHATS_PROJECT, MAIN_CHAT, MEMORY_DAILY_ROUTINE, mimeForFile, providerFor, type Attachment, type MiniAppCheck, type MiniAppRow, type Settings } from '@agent/core'

import { registerIpc, type DialogLike, type WindowControls } from './ipc'
import { AccountService } from './account'
import { APP_ID, APP_NAME, LICENCES_URL, makeAppInfo, windowTitle } from './app-info'
import { AgentBrowser } from './browser/browser'
import type { GuideStep } from './browser/guide'
import { HOST_WINDOW_PREFS, keepPagesAwake } from './browser/keep-awake'
import { runTurnstileProbe } from './browser/turnstile-probe'
import { fallbackUserAgent } from './browser/emulation'
import { runDevtoolsProbe } from './browser/devtools-probe'
import { Store } from './db'
import { Logger } from './logger'
import { onDestroyedSkip, safeSend, uncaughtHandler, whileAlive } from './alive'
import { Notifier } from './notify'
import { QuickAskWindow, quickAskPaths, type HotkeyStatus } from './hotkey'
import { HotkeyManager } from './hotkeys'
import { cachedLister, likelyHolder, listProcesses } from './hotkey-holders'
import { createDictation, type DictationSetup } from './dictation/setup'
import { Recordings } from './recordings/store'
import { recoveredNoticeText, startRecordingsUpkeep, type Upkeep } from './recordings/upkeep'
import { chatTag } from './runtime/chat-lines'
import { registerDictationIpc } from './dictation/ipc'
import { StepBudget } from './runtime/budget'
import { hostEnvironment } from './runtime/environment-host'
import { HelperManager } from './runtime/helpers'
import { clipboardAttachments } from './clipboard-files'
import { savePastedFile } from './pasted'
import { Runner } from './runtime/runner'
import { TurnLeases } from './runtime/turns'
import { ProjectAgentRows } from './runtime/project-agents'
import { devicesState, ownBrainIds, type DevicesSyncDeps } from './devices/sync'
import { attachDevicesSync } from './devices/attach'
import { registerRelay, rolesFromStore } from './devices/relay'
import { Scheduler } from './runtime/scheduler'
import { watchBackgroundScripts } from './runtime/script-runs'
import { liveRuns } from './runtime/live-runs'
import { setOwnerLabeller } from './browser/owner'
import { startOffload, type OffloadWire } from './devices/offload-wire'
import { buildToolset, buildWorkerToolset } from './runtime/toolset'
import { AppsService } from './apps/service'
import { MINE_PARTITION, ProfileStore } from './apps/profiles'
import { adoptEarlierChats } from './projects/earlier'
import { ConnectedAppsFile, LearnedStore } from './apps/store'
import { CliHost } from './runtime/cli-host'
import { Secrets } from './secrets'
import { SettingsStore } from './settings'
import { createTray, type TrayHandle } from './tray'
import { startUpdates } from './updates'
import { EVENTS } from '../shared/channels'
import { registerVoiceIpc } from './voice/ipc'
import { HelperFeed } from './devices/helper-feed'
import { ChatIndex } from './memory/chat-index'
import { EMPTY_VOCABULARY, dictationWordsFromProjects, vocabularyFrom } from './memory/vocabulary'
import { registerMemoryHistoryIpc } from './memory/history-ipc'
import { registerMemoryIpc } from './memory/ipc'
import { MemoryTidy, TidyFile } from './memory/tidy'
import { MemoryService } from './memory/service'
import { UpkeepFile } from './memory/upkeep-log'
import { dailyRoutineSlot, ensureDailyRoutine, recordDailyRun, resultLine } from './memory/routine'
import { MEMORY_EVENTS } from '../shared/memory-channels'
import { allowMicrophone } from './voice/permissions'
import { VoiceService } from './voice/service'
import { EventRouter } from './workers/router'
import { registerWorkersIpc } from './workers/ipc'
import { VaultStore } from './vault/store'
import { BrowserVault } from './vault/browser-vault'
import { setVaultRedactor } from './vault/redact'
import { registerVaultIpc } from './vault/ipc'
import { VAULT_EVENTS } from '../shared/vault-channels'
import { killLeftover, killTree, spawnWorker } from './workers/spawn'
import { WorkerStore } from './workers/store'
import { Supervisor } from './workers/supervisor'
import { WORKER_EVENTS } from '../shared/workers-channels'
import { recordHandlers, handlerRegistry } from './devices/registry'
import { DevicesService, setDevicesService } from './devices/service'
import { SelfUpdater, resumeNote } from './self-update'
import type { AppControlDeps } from './tools/app-control'
import { registryInvoker } from './tools/app-actions'
import { findSidecar } from './devices/net'
import { DEFAULT_SHARE, DeviceToolHost } from './devices/device-tool-host'
import { WindowsFirewall } from './devices/firewall'
import { routeLate } from './devices/device-tools'
import { startPresence, type PresenceHandle } from './presence/start'
import { getWakeups, setWakeups, WakeupService } from './wakeups/service'
import { RingWindow } from './wakeups/ring-window'
import { wakeIdleState } from './wakeups/idle'
import { MiniAppStore } from './miniapps/store'
import { MiniAppHost, setMiniAppHost } from './miniapps/host'
import { guardMiniAppFrames, registerMiniAppScheme, rendererFonts, serveMiniAppsIn } from './miniapps/protocol'
import { registerMediaFetch } from './media/fetch'
import { registerMediaScheme, serveMediaIn } from './media/protocol'
import { ShownMedia } from './media/shown'
import { latestOrigin } from './devices/origin'
import { MiniAppChecker } from './miniapps/check'
import { registerMiniAppIpc, registerMiniAppRpc } from './miniapps/ipc'
import { MINIAPP_EVENTS } from '../shared/miniapps-channels'
import type { MiniAppUi } from './tools/miniapps'
import { registerWakeupIpc, registerWakeupRpc, WakeDeviceReports } from './wakeups/bridge'
import { RunGitHook } from './git/hook'
import { vaultHashesOf, type VaultHashes } from './git/secret-scan'
import { gitStatusReport } from './git/report'
import { GIT_CHANNELS } from '../shared/git-channels'
import { WAKEUP_RPC } from '../shared/wakeups-channels'
import { getDevicesHost } from './devices/service'
import { copyVerdict, defaultInstalledExe, isInstalledCopy } from './install-guard'
import { startWatchdog, type Watchdog } from './watchdog'
import { autoHelperCap, busyReason, DEFAULT_LIMITS, ResourceMonitor, shortOf, type ResourceLimits } from './runtime/resources'
import { warmRecall } from './runtime/recall'
import { existsSync as fileExists } from 'node:fs'
import { spawn as spawnProcess } from 'node:child_process'

// Every IPC handler is also kept by channel, so a paired device can call it over the wire (devices/rpc.ts).
const ipcMain = recordHandlers(electronIpcMain)

const isSmoke = process.argv.includes('--smoke')
const smokeTimeoutMs = 30_000

app.setName(APP_NAME)
// A second copy (tests, a live proof next to the person's own app) runs with its own data folder, and so its own
// single-instance lock. Unset in normal use.
const userDataOverride = process.env['AGENT_USER_DATA']?.trim() ?? ''
if (userDataOverride !== '') app.setPath('userData', userDataOverride)
// A test or unpacked copy never opens the person's own data folder (install-guard.ts): it hands over to the installed
// app, or says why, before anything is read or locked.
const copyFacts = {
  platform: process.platform,
  packaged: app.isPackaged,
  exe: app.getPath('exe'),
  productName: APP_NAME,
  userDataOverride,
  userDataSwitch: app.commandLine.hasSwitch('user-data-dir'),
  allowDefault: process.env['AGENT_ALLOW_DEFAULT_DATA'] === '1',
  installedExe: defaultInstalledExe(process.env, APP_NAME),
  exists: (path: string) => fileExists(path),
}
const copyCheck = copyVerdict(copyFacts)
const refuseToStart = !copyCheck.ok
if (refuseToStart) {
  if (copyCheck.handTo !== '') {
    try {
      spawnProcess(copyCheck.handTo, process.argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } catch {
      // nothing to hand over to after all: the box below says why
    }
  } else {
    dialog.showErrorBox(APP_NAME, `${copyCheck.why}\n\nStart the installed ${APP_NAME}, or give this copy its own data folder (AGENT_USER_DATA).`)
  }
  app.exit(0)
}
// Set once, before any window or notification exists, so Windows shows toasts under the app's name.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

const logsDir = join(app.getPath('userData'), 'logs')
const logger = new Logger(logsDir)
// Mini-apps are served from miniapp://<id>/ (main/miniapps/protocol.ts); a privileged scheme is declared before ready.
registerMiniAppScheme()
// A file an agent shows plays in the chat from agent-media://f/<token> (main/media/protocol.ts); nothing else is served.
registerMediaScheme()
/**
 * The files an agent has shown him: a video, a picture, a sound. Kept beside the app's data so an older card still
 * plays, and held here so the window's own session can stream from it.
 */
const shownMedia = new ShownMedia(join(app.getPath('userData'), 'shown-media.json'))
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

// A page or window that closed under one of its callbacks is logged and skipped (alive.ts); a real fault asks.
onDestroyedSkip((what, error) =>
  logger.warn('Skipped a closed page or window', { what, stack: error instanceof Error ? error.stack : String(error) }),
)
process.on(
  'uncaughtException',
  uncaughtHandler({
    log: (message, fields) => logger.error(message, fields),
    dialog: () => showCalmDialog('Your saved work is safe. You can keep going, or restart the app.', true),
  }),
)

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
/** Which windows are hidden from screen sharing, by the two privacy settings (capture-privacy.ts). */
let capturePrivacy: CapturePrivacy | null = null
let account: AccountService | null = null
let runner: Runner | null = null
/** The helpers, so quitting can leave the ones still working for the next start to report (HelperManager.restore). */
let helperManager: HelperManager | null = null
/** Turn leases: a turn or helper cut off by a crash resumes on the next start (runtime/turns.ts). */
let leases: TurnLeases | null = null
/** The app's side of registerDevicesSync (set once the runtime is built). */
let disposeDevicesSync: (() => void) | null = null
let devicesAppHooks: Pick<DevicesSyncDeps, 'leases' | 'localTools' | 'shareGroups' | 'preferred' | 'noteBack' | 'context'> | null = null
let memory: MemoryService | null = null
let chatIndex: ChatIndex | null = null
let voice: VoiceService | null = null
let cliHost: CliHost | null = null
let scheduler: Scheduler | null = null
let workerStore: WorkerStore | null = null
let vaultStore: VaultStore | null = null
let supervisor: Supervisor | null = null
let eventRouter: EventRouter | null = null
/** Where the person is (presence/): the note on his messages, his calendars cached, meetings that end early. */
let presenceHandle: PresenceHandle | null = null
let wakeupService: WakeupService | null = null
let miniappHost: MiniAppHost | null = null
let miniappRpc: ((host: import('./devices/types').DevicesHost) => void) | null = null
/** Showing and looking at mini-apps: only this window can (tools/miniapps.ts). */
let miniappUi: MiniAppUi | null = null
const wakeReports = new WakeDeviceReports()
/** His recordings on disk (recordings/), and the pass that recovers, tells him and deletes old audio. */
let recordingsStore: Recordings | null = null
let recordingsUpkeep: Upkeep | null = null
/** The Workers page reads again; a burst of events tells it once, and says which workers (main/workers/changed.ts). */
const workersChanged = createWorkersChanged((payload) => broadcast(WORKER_EVENTS.changed, payload))
let tray: TrayHandle | null = null
let quickAsk: QuickAskWindow | null = null
let hotkeys: HotkeyManager | null = null
let hotkeyRetry: NodeJS.Timeout | null = null
const runningProcesses = cachedLister(listProcesses)
let dictation: DictationSetup | null = null
let agentBrowser: AgentBrowser | null = null
let disposeIpc: (() => void) | null = null
let disposeStore: (() => void) | null = null
let disposeSettings: (() => void) | null = null

let quitting = false
let toldAboutTray = false
let routinesPaused = false
let lastHotkeyStatuses: HotkeyStatus[] = []
const filePicks = new Set<string>()

let devices: DevicesService | null = null

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) safeSend(win, channel, payload)
  // Paired devices hear the same events (only the ones they may: shared/rpc-methods.ts RPC_EVENTS).
  devices?.broadcast(channel, payload)
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

const WINDOW_MIN_WIDTH = 360
const WINDOW_MIN_HEIGHT = 600
const WINDOW_FIT = { minWidth: WINDOW_MIN_WIDTH, minHeight: WINDOW_MIN_HEIGHT, defaultWidth: 1280, defaultHeight: 820 }

/** The last rectangle he gave the window himself (moved or resized, not snapped, maximised or minimised). */
let lastFreeBounds: Rectangle | null = null
/** How much bigger the system reports the window than it was made (window-fit.ts frameDelta); taken off before saving. */
let mainFrameDelta: FrameDelta = { width: 0, height: 0 }

/** The window's rectangle as it would be asked for again: what it reports, less the frame difference. */
function chosenBounds(win: BrowserWindow): Rectangle {
  return withoutFrame(win.getBounds(), mainFrameDelta)
}

function currentWorkAreas(): Rectangle[] {
  try {
    return workAreasPrimaryFirst(screen.getPrimaryDisplay(), screen.getAllDisplays())
  } catch {
    return []
  }
}

function workAreaOf(bounds: Rectangle): Rectangle | null {
  try {
    return screen.getDisplayMatching(bounds).workArea
  } catch {
    return null
  }
}

/** Where the window opens: the saved rectangle made to fit the screens there are now (window-fit.ts). */
function fittedWindowState(saved: WindowState): WindowState {
  const fit = fitWindowToDisplay(saved, currentWorkAreas(), WINDOW_FIT)
  return { width: fit.width, height: fit.height, x: fit.x, y: fit.y, maximized: fit.maximized }
}

/** Remember the size he chose, not a snapped half of the screen (a snapped window's normal bounds are the snap). */
function trackFreeBounds(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const note = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (win.isDestroyed() || win.isMaximized() || win.isMinimized() || win.isFullScreen()) return
      const bounds = chosenBounds(win)
      const area = workAreaOf(bounds)
      if (area !== null && looksSnapped(bounds, area)) return
      lastFreeBounds = bounds
    }, 400)
  }
  win.on('move', note)
  win.on('resize', note)
  win.on('closed', () => {
    if (timer !== null) clearTimeout(timer)
  })
}

/** A screen was unplugged, added or changed size or scale: every window of ours moves fully back onto one. */
function refitWindowsToScreens(): void {
  const win = mainWindow
  if (win !== null && !win.isDestroyed() && !win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
    const bounds = chosenBounds(win)
    const fit = fitWindowToDisplay({ ...bounds, maximized: false }, currentWorkAreas(), { ...WINDOW_FIT, allowMaximize: false })
    if (fit.x !== null && fit.y !== null) {
      const next = { x: fit.x, y: fit.y, width: fit.width, height: fit.height }
      if (!sameRect(next, bounds)) {
        win.setBounds(next)
        logger.info('Window moved back onto a screen', { from: JSON.stringify(bounds), to: JSON.stringify(next) })
      }
    }
  }
  quickAsk?.refit()
  dictation?.pill.refit()
}

let watchingScreens = false
function watchScreens(): void {
  if (watchingScreens) return
  watchingScreens = true
  let timer: NodeJS.Timeout | null = null
  // Windows sends a burst of these while it rearranges; act once it settles.
  const later = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      refitWindowsToScreens()
    }, 500)
  }
  screen.on('display-removed', later)
  screen.on('display-added', later)
  screen.on('display-metrics-changed', later)
}

function writeWindowState(file: string, win: BrowserWindow): void {
  try {
    let bounds = withoutFrame(win.getNormalBounds(), mainFrameDelta)
    if (!win.isMaximized() && lastFreeBounds !== null) {
      const area = workAreaOf(bounds)
      if (area !== null && looksSnapped(bounds, area)) bounds = lastFreeBounds
    }
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
  win.on('maximize', () => safeSend(win, EVENTS.maximize, true))
  win.on('unmaximize', () => safeSend(win, EVENTS.maximize, false))
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
  const stored = readWindowState(stateFile)
  // Never restored blindly: the screen it was saved on may be gone, smaller, or the rectangle a snap (window-fit.ts).
  const saved = fittedWindowState(stored)
  if (saved.x !== stored.x || saved.y !== stored.y || saved.width !== stored.width || saved.height !== stored.height) {
    logger.info('Window fitted to the screen', { saved: JSON.stringify(stored), opens: JSON.stringify(saved) })
  }
  const win = new BrowserWindow({
    title: windowTitle(),
    width: saved.width,
    height: saved.height,
    ...(saved.x !== null && saved.y !== null ? { x: saved.x, y: saved.y } : {}),
    minWidth: Math.min(WINDOW_MIN_WIDTH, saved.width),
    minHeight: Math.min(WINDOW_MIN_HEIGHT, saved.height),
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
      // The agent's browser pages are <webview>s inside the browser card, so they move with it. Only this window
      // may host them, and browser/embed.ts locks every one down before it attaches.
      webviewTag: true,
      // It hosts those pages: minimised or covered, it still creates and attaches them (browser/keep-awake.ts).
      ...HOST_WINDOW_PREFS,
    },
  })

  mainWindow = win
  // The app window holds the chat: "hide the chat from screen sharing" hides it whole (capture-privacy.ts).
  capturePrivacy?.register(win, 'main')
  if (saved.x !== null && saved.y !== null) {
    // Created frameless on a scaled screen, Windows makes it a few pixels bigger than asked (1200x700 opens as
    // 1206x707 at 125%); one setBounds puts it right. What it then reports, a pixel or two over, is the frame.
    const want = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    win.setBounds(want)
    mainFrameDelta = frameDelta(want, win.getBounds())
    lastFreeBounds = want
  }
  trackFreeBounds(win)
  watchScreens()

  win.once('ready-to-show', () => {
    // A screen scale other than the one it was saved at can make Windows resize or move it on creation: put it back.
    if (saved.x !== null && saved.y !== null) {
      const want = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
      if (!sameRect(chosenBounds(win), want)) win.setBounds(want)
    }
    if (saved.maximized) win.maximize()
    win.show()
    logger.info('Window shown', { ms: Math.round(process.uptime() * 1000) })
  })

  win.on('focus', retryHotkeys)

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

  win.webContents.on(
    'will-navigate',
    whileAlive(win, 'window will-navigate', (event: Electron.Event, url: string) => {
      if (url !== win.webContents.getURL()) event.preventDefault()
    }),
  )

  // The shortcut is registered before the renderer is ready, so a fresh window is told the result.
  win.webContents.on('did-finish-load', () => {
    for (const status of lastHotkeyStatuses) safeSend(win, EVENTS.hotkey, status)
  })

  win.on(
    'page-title-updated',
    whileAlive(win, 'window title', (event: Electron.Event) => {
      event.preventDefault()
      win.setTitle(windowTitle())
    }),
  )

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
  // Hidden in the tray while a screen went away: it comes back onto one that exists.
  refitWindowsToScreens()
  mainWindow.focus()
}

function applyLoginItem(settings: Settings): void {
  // Only the installed app registers itself: a test copy would point "launch at login" at its own folder.
  if (!isInstalledCopy(copyFacts)) return
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
  // Unchanged shortcuts are left alone by the manager; a change reports every status again.
  hotkeys?.apply({
    quickAsk: settings.quickAskHotkey,
    dictate: settings.dictateHotkey,
    dictateClean: settings.dictateCleanHotkey,
  })
}

/** Shortcuts another app held may be free now (that app quit): try again, quietly. */
function retryHotkeys(): void {
  const freed = hotkeys?.retry() ?? []
  if (freed.length > 0) logger.info('Shortcuts registered after a retry', { actions: freed.join(',') })
}

/** Names the app that probably holds each blocked shortcut (Wispr Flow, PowerToys Run...), when it can tell. */
async function explainBlockedHotkeys(): Promise<void> {
  const blocked = hotkeys?.blocked() ?? []
  if (blocked.length === 0) return
  const running = await runningProcesses()
  for (const { action, accelerator } of blocked) hotkeys?.explain(action, likelyHolder(accelerator, running, process.platform))
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

async function pickImportFile(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Choose a memory export',
    properties: ['openFile'],
    filters: [{ name: 'Memory export', extensions: ['json'] }],
  }
  const result =
    mainWindow === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(mainWindow, options)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
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

let watchdog: Watchdog | null = null
let resourceMonitor: ResourceMonitor | null = null

/** The helper queue's view of this computer: thresholds from Settings, read live. */
function helperResources(settings: { get(): Settings }): import('./runtime/helpers').HelperResources {
  const limits = (): ResourceLimits => {
    const s = settings.get()
    const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
    return { minFreeRamGb: num(s.helperMinFreeRamGb, DEFAULT_LIMITS.minFreeRamGb), minFreeDiskGb: num(s.helperMinFreeDiskGb, DEFAULT_LIMITS.minFreeDiskGb), busyCpuPercent: num(s.helperBusyCpu, DEFAULT_LIMITS.busyCpuPercent) }
  }
  return {
    short: () => shortOf(resourceMonitor?.now() ?? null, limits()),
    busy: () => busyReason(resourceMonitor?.now() ?? null, limits()),
    comfortable: () => (resourceMonitor === null ? Number.POSITIVE_INFINITY : autoHelperCap(resourceMonitor.cores(), resourceMonitor.totalRamGb())),
    onSample: (listener) => resourceMonitor?.onSample(listener) ?? (() => undefined),
  }
}

async function startServices(win: BrowserWindow): Promise<void> {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })

  store = new Store(join(dir, 'agent.db'))
  // Checkpoints off the main thread (db-checkpoint.ts): a checkpoint inside an ordinary write took up to 2 s.
  store.startCheckpointer({ log: (line, detail) => logger.info(line, detail) })
  // Reads of the big tables run in worker threads (db-reader.ts): no read can hold the window or the links.
  store.startReader({ log: (line, detail) => logger.warn(line, detail) })
  const settings = new SettingsStore(join(dir, 'settings.json'))
  settingsStore = settings
  const privacy = new CapturePrivacy(() => settings.get())
  capturePrivacy = privacy
  if (mainWindow !== null && !mainWindow.isDestroyed()) privacy.register(mainWindow, 'main')
  // The main thread blocked for a second or more goes to main.log with its stacks (watchdog.ts).
  const watchMs = settings.get().watchdogMs
  watchdog = startWatchdog({
    blockedMs: typeof watchMs === 'number' ? watchMs : 1000,
    onBlocked: (report) => {
      // The stacks say where; the reads beside them say which query, what it asked and how many rows it brought back.
      const reads = store?.recentReads(report.at - 1_000).filter((read) => read.at <= report.at + report.ms + 1_000) ?? []
      logger.warn('Main thread blocked', { ms: report.ms, at: new Date(report.at).toISOString(), stacks: report.stacks, ...(reads.length === 0 ? {} : { reads }), ...(report.note === undefined ? {} : { note: report.note }) })
    },
    onError: (why) => logger.warn('Watchdog problem', { why }),
  })
  // What this computer has to spare, for starting helpers (runtime/resources.ts).
  resourceMonitor = new ResourceMonitor(dir)
  resourceMonitor.start()
  // Old finished steps' long outputs move out of the chat rows, a little at a time, never while memory or disk is short.
  // Every memory page's words are worked out in slices ahead of the first turn (runtime/recall.ts).
  const warmStore = store
  setTimeout(() => void warmStore.list('memory').then((pages) => warmRecall(pages)).catch(() => undefined), 20_000).unref?.()
  store.startArchiver({
    // It frees memory later but costs a little now, so it holds off only when things are truly tight.
    busy: () => {
      const now = resourceMonitor?.now() ?? null
      return now !== null && (now.freeRamGb < 0.5 || (now.freeDiskGb >= 0 && now.freeDiskGb < 2))
    },
    log: (line, detail) => logger.info(line, detail),
  })
  const secrets = new Secrets(join(dir, 'secrets'), safeStorage)
  // The Vault (vault/store.ts): from here on no vault value is written into a row, a log or a tool result.
  const vault = new VaultStore(secrets)
  vaultStore = vault
  setVaultRedactor((text) => vault.redact(text))
  vault.onChange(() => broadcast(VAULT_EVENTS.changed, null))
  const browserVault = new BrowserVault(vault, (message, detail) => logger.info(message, detail))
  // Settings > Git: a run's work in a git repo is committed and pushed when it ends (git/hook.ts). Off by default.
  const gitStore = store
  const gitKv = { get: (key: string) => gitStore.localValue(key), set: (key: string, value: string) => gitStore.setLocalValue(key, value) }
  let gitVault: { at: number; hashes: VaultHashes } | null = null
  const gitHook = new RunGitHook({
    settings: () => settings.get(),
    kv: gitKv,
    // The vault's values only as hashes, remade when the vault changes (the secret check compares hashes).
    vault: () => {
      const at = vault.changedAt()
      if (gitVault === null || gitVault.at !== at) gitVault = { at, hashes: vaultHashesOf(vault.redactions().map((entry) => entry.needle)) }
      return gitVault.hashes
    },
    log: (line) => logger.info(line),
  })
  ipcMain.handle(GIT_CHANNELS.log, () => gitHook.log(50))
  ipcMain.handle(GIT_CHANNELS.report, async () => {
    const projects = await gitStore.list('project').catch(() => [])
    const folders = projects.filter((p) => p.path.trim() !== '').map((p) => ({ name: p.name, path: p.path }))
    // The window's view never moves the nightly report's baseline: a scratch key-value.
    const scratch = new Map<string, string>()
    return (await gitStatusReport(folders, { get: (k) => scratch.get(k) ?? null, set: (k, v) => void scratch.set(k, v) }, { full: true })).repos
  })
  // The old single AI choice becomes the first account, once; after that the accounts list is the truth.
  migrateLegacyAccount(settings, secrets)
  const accounts = new AccountStore(settings, secrets)
  const brainLocks = new FileBrainLocks(join(dir, 'brain-locks.json'))
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
  // Look at the computer in the background, once the window has painted (the scan walks the PATH). It only runs
  // `--version`; nothing is installed or sent.
  if (isSmoke) void environment.scan().catch(() => undefined)
  else win.webContents.once('did-finish-load', () => setTimeout(() => void environment.scan().catch(() => undefined), 400))
  const updates = startUpdates()
  logger.info('Updates', { status: updates.status })

  agentBrowser = new AgentBrowser({
    window: win,
    onState: (state) => broadcast(EVENTS.browser, state),
    // Closing the tab an agent handed over answers its "needs you in the browser" card, so nothing waits forever.
    onHandoffClosed: () => {
      void (async () => {
        const rows = store === null ? [] : await store.listWhere('chat_item', { kind: 'question' })
        for (const row of rows) {
          if (row.kind !== 'question') continue
          let meta: Record<string, unknown> = {}
          try {
            meta = JSON.parse(row.meta) as Record<string, unknown>
          } catch {
            continue
          }
          const options = Array.isArray(meta['options']) ? meta['options'] : []
          if (meta['answer'] === '' && options.includes('Done, carry on')) await runner?.answer(row.id, HANDOFF_CLOSED)
        }
      })().catch(() => undefined)
    },
    openExternal: (url) => shell.openExternal(url),
    sitesFile: join(app.getPath('userData'), 'browser-sites.json'),
    // The person's own tabs keep their own sign-ins, apart from every agent's (apps/profiles.ts MINE_PARTITION).
    personPartition: MINE_PARTITION,
    // Hand to the agent: the page's note and picture are ordinary attachments, and land in the message box.
    handOver: {
      root: join(app.getPath('userData'), 'attachments'),
      agentName: () => settings.get().agentName,
      deliver: (page) => broadcast(EVENTS.browserHandOver, page),
    },
    // The guide's ring and label wear the app's own look: his theme and accent, read live (shared/brand.ts).
    look: () => brandLook({ theme: settings.get().theme, accent: settings.get().accent, systemDark: nativeTheme.shouldUseDarkColors }),
    // The ring and label in a window of their own that screen sharing leaves out, where this computer can do that.
    privateGuides: {
      // AGENT_GUIDE_PROBE_OVERLAY=1 (a layout proof on a system that cannot hide a window; never set in normal use)
      // draws in the overlay window all the same. It hides nothing there, and the overlay's own state says so.
      on: () => guidesUseOverlay(settings.get().hideGuidesFromCapture, privacy.exclusion) || (process.env['AGENT_GUIDE_PROBE_OVERLAY'] === '1' && settings.get().hideGuidesFromCapture),
      overlay: () => createGuideOverlay({ privacy }),
    },
  })
  agentBrowser.setVault(browserVault)
  // The human-verification regression probe: load a page with a Turnstile widget (or a managed challenge), read
  // what the page and its Worker see, write one JSON file and quit. Never set in normal use.
  const turnstileProbeUrl = process.env['AGENT_TURNSTILE_PROBE']?.trim() ?? ''
  if (turnstileProbeUrl !== '') {
    setTimeout(() => {
      const browser = agentBrowser
      if (browser === null) return
      const out = process.env['AGENT_TURNSTILE_PROBE_OUT']?.trim() ?? ''
      const waitMs = Number(process.env['AGENT_TURNSTILE_PROBE_WAIT_MS'] ?? '30000')
      void runTurnstileProbe(browser, turnstileProbeUrl, out, Number.isFinite(waitMs) ? waitMs : 30_000, () => app.quit())
    }, 3000)
  }
  // The computer switched light/dark while the theme follows it: a ring showing now changes with it.
  const onSystemTheme = (): void => {
    if (settings.get().theme === 'system') void agentBrowser?.restyleGuides()
  }
  nativeTheme.on('updated', onSystemTheme)
  // The real-Electron browser proof opens a local test page here; never set in normal use.
  const probeUrl = process.env['AGENT_BROWSER_PROBE_URL']?.trim() ?? ''
  if (probeUrl !== '') {
    setTimeout(() => {
      const browser = agentBrowser
      if (browser === null) return
      void (async () => {
        console.log(`BROWSER PROBE opened\n${await browser.probeOpen(probeUrl)}`)
        if (process.env['AGENT_DEVTOOLS_PROBE'] === '1') await runDevtoolsProbe(browser)
        // The guide proof: a guide on the probe page, its steps as JSON ([{ "target": { "selector": "#go" }, "label":
        // "Click Check out" }]). It ends as any guide does: his click, I did it, Skip, or its time running out.
        const guideProbe = process.env['AGENT_GUIDE_PROBE']?.trim() ?? ''
        if (guideProbe !== '') {
          void (async () => {
            try {
              const steps = JSON.parse(guideProbe) as GuideStep[]
              const limit = Number(process.env['AGENT_GUIDE_PROBE_TIMEOUT_MS'] ?? '')
              console.log(`GUIDE PROBE started ${steps.length}`)
              console.log(`GUIDE PROBE result\n${await browser.guide({ steps, ...(Number.isFinite(limit) && limit > 0 ? { timeoutMs: limit } : {}) })}`)
            } catch (error) {
              console.log(`GUIDE PROBE failed ${error instanceof Error ? error.message : String(error)}`)
            }
          })()
        }
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
  // Named, so the devices bundle can carry the per-account rules too (devices/bundle.ts).
  const connectedApps = new ConnectedAppsFile(join(dir, 'connected-apps.json'))
  const apps = new AppsService({
    secrets,
    file: connectedApps,
    learned,
    // Profiles stay on this computer (not a synced entity yet).
    profiles: new ProfileStore(join(dir, 'profiles.json')),
    openExternal: (url) => shell.openExternal(url),
  })
  const learnedNames = (): Record<string, string> => Object.fromEntries(learned.apps().map((a) => [a.id, a.name]))

  // `sessionId` is how a turn retries a picture the provider's gateway refused to route (runtime/vision.ts): the
  // same provider and model, a fresh session, which is what OpenCode Go picks its engine from.
  const factory = (current: ReturnType<SettingsStore['get']>, key: string, sessionId?: string): ReturnType<typeof providerFor> =>
    providerFor({
      provider: current.provider,
      key,
      baseUrl: current.baseUrl.trim() || undefined,
      allowHttp: current.allowHttp,
      ...(sessionId === undefined ? {} : { sessionId }),
    })
  const budget = new StepBudget()
  // Background workers (docs/workers-and-triggers.md): agent-written scripts the app keeps running. Their events
  // go to the router, which hands them to the desk of each event routine; it is created once the helpers exist.
  const workers = new WorkerStore(join(dir, 'workers'))
  workerStore = workers
  const workerNotice = async (text: string): Promise<void> => {
    try {
      await store?.upsert('chat_item', { kind: 'notice', text, meta: JSON.stringify({ workers: true }) })
      broadcast(EVENTS.chat, { type: 'chat_changed' })
    } catch {
      // The Workers page and the notification still show it.
    }
  }
  supervisor = new Supervisor({
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
      showNotification(`${worker.name} keeps failing`, `${worker.lastError || 'It stopped too often.'} Open Routines, Workers to restart it.`)
      void workerNotice(`Worker "${worker.name}" keeps failing and was stopped: ${worker.lastError || 'it exited too often'}. Restart it on the Routines page, Workers.`)
    },
    onChange: (workerId) => workersChanged(workerId),
  })
  const workerTools = { store: workers, supervisor }
  // Runs on the person's own plan (Claude Agent SDK / Codex SDK): the main agent and every helper.
  cliHost = new CliHost(join(app.getPath('userData'), 'cli'), () => settings.get(), app.getAppPath())
  const leaseStore = store
  leases = new TurnLeases({
    store: leaseStore,
    selfId: () => devicesState.sync?.selfId() ?? leaseStore.deviceId,
    ownIds: () => ownBrainIds(leaseStore),
    resumeTurn: (chat, id, note) => runner?.resumeTurn(chat, id, note),
    resumeJob: async (id, note) => {
      await helpers.push(id, note)
    },
    lost: (lease) => {
      // Another brain carries it on and tells its creator when it ends: this brain lets go without a notice.
      if (lease.kind === 'job') void helpers.letGo(lease.messageId)
      else runner?.stop(lease.chatId)
    },
  })
  // A project agent the main agent hands work to shows as a helper row in the main chat, with the project's icon.
  // Devices (s12): helpers, project chats and routines placed on another brain (devices/offload-wire.ts).
  let offloadWire: OffloadWire | null = null
  const projectAgents = new ProjectAgentRows({
    store,
    state: (chat) => {
      const local = runner?.state(chat) ?? { running: false, waiting: [] }
      return offloadWire?.state(local, chat) ?? local
    },
    changed: () => broadcast(EVENTS.chat, { type: 'chat_changed' }),
  })
  // The app's own controls as tools (tools/app-control.ts): what Settings does by clicking, the agent can do too.
  const selfUpdater = new SelfUpdater({
    userData: dir,
    currentVersion: app.getVersion(),
    productName: 'Agent',
    execPath: process.execPath,
    platform: process.platform,
    packaged: app.isPackaged,
    busy: (chat) => runner?.state(chat).running ?? false,
    quit: () => app.quit(),
    // The update could not start (the app stays up): the chat that asked hears the real reason.
    tell: (chat, text) => void runner?.deliver(text, chat).catch(() => undefined),
    // The launcher starts outside this app with the user's default environment: a copy run with its own data
    // folder must come back with it.
    relaunchEnv: userDataOverride !== '' ? { AGENT_USER_DATA: userDataOverride } : {},
    log: (message, detail) => logger.info(message, detail),
  })
  const appControl: AppControlDeps = {
    devices: () => devices,
    links: () => devicesState.sync?.replicator.status() ?? [],
    settings,
    invoker: () => registryInvoker(handlerRegistry),
  }
  // His recordings and dictations, written to disk as they happen and recovered after a crash (recordings/store.ts).
  const recordings = new Recordings({ root: join(dir, 'voice-notes', 'recordings'), log: (message, fields) => logger.info(message, fields) })
  recordingsStore = recordings
  const helperToolset = buildWorkerToolset({
    appControl,
    deviceHub: () => devicesState.sync?.tools ?? null,
    store,
    settings,
    browser: agentBrowser,
    agentName: () => settings.get().agentName,
    environment,
    apps,
    learned,
    workers: workerTools,
    vault,
    browserVault,
    recordings,
    calendar: () => presenceHandle?.calendar ?? null,
    miniappUi: () => miniappUi,
    git: { kv: gitKv, hook: () => gitHook },
  })
  // What registerDevicesSync needs from the app (devices/sync.ts), for the node server's call site:
  // registerDevicesSync(host, { store, pass, bundle, ...devicesAppHooks })
  devicesAppHooks = {
    leases,
    localTools: () => helperToolset,
    shareGroups: () => settings.get().devicesShareGroups,
    preferred: () => settings.get().devicesPreferred,
    // A late device result goes only to the run that asked for it (devices/device-tools.ts routeLate).
    noteBack: async (chat, text, owner) => {
      await routeLate(
        {
          deliver: async (note, where) => {
            if (runner !== null) await runner.deliver(note, where)
          },
          helper: async (id, note) => (helperManager === null ? 'unknown' : helperManager.lateResult(id, note)),
        },
        chat,
        text,
        owner,
      )
    },
    // ask_user / request_approval another brain runs here show as cards in that chat on this computer.
    context: (chat, signal) => runner?.deviceContext(chat, signal) ?? {},
  }
  const helpers = (helperManager = new HelperManager({
    leases,
    dataDir: dir,
    store,
    cli: cliHost,
    settings,
    secrets,
    providerFactory: factory,
    workerTools: helperToolset,
    deliver: async (note, chat) => {
      if (runner !== null) await runner.deliver(note, chat)
    },
    alongsideDone: async (chat, helperId) => {
      if (runner !== null) await runner.alongsideDone(chat, helperId)
    },
    platform: process.platform,
    emit: (event) => broadcast(EVENTS.chat, event),
    notify: showNotification,
    profiles: apps.profiles,
    learnedNames,
    git: gitHook,
    resources: helperResources(settings),
  }))
  // Every browser tab names the run that owns it, in plain words (browser.state, the panel).
  setOwnerLabeller((owner) => {
    const run = liveRuns.byOwner(owner)[0]
    if (run !== undefined) return `${run.kind}: ${run.label}`
    if (owner.startsWith('helper:')) {
      const helper = helpers.live().find((each) => each.id === owner.slice(7))
      if (helper !== undefined) return `helper: ${helper.label}`
    }
    return ''
  })
  // Where he is, on every message he sends (presence/presence.ts): his calendars are read from Connections and cached.
  const presenceStore = store
  presenceHandle = startPresence({
    store: presenceStore,
    dataDir: dir,
    apps: { activeAccounts: (list) => apps.activeAccounts(list), backend: () => apps.backend(), rulesFor: (id) => connectedApps.rulesFor(id) },
    selfId: () => devicesState.sync?.selfId() ?? '',
    isFocused: () => (mainWindow === null || mainWindow.isDestroyed() ? null : mainWindow.isFocused()),
    idleSeconds: () => {
      try {
        return powerMonitor.getSystemIdleTime()
      } catch {
        return null
      }
    },
    // A meeting that ended early is an event like a worker's, so a routine can listen for it too.
    emitEvent: (input) => {
      const stored = workers.addEvent(input.source, input)
      if (stored !== null) void eventRouter?.offer(stored)
      workersChanged(input.source)
    },
    log: (message, detail) => logger.info(message, detail),
  })
  const presence = presenceHandle.presence
  // Wake-ups (main/wakeups): rings this computer full screen until he answers, here, on the phone or in Settings.
  {
    const wakeStore = store
    const me = (): { id: string; name: string } => ({ id: wakeupService?.selfId() ?? '', name: settings.get().deviceName })
    const ring = new RingWindow({
      onAck: (id) => void wakeupService?.ack(id, me()),
      onSnooze: (id) => void wakeupService?.snooze(id, me()),
      // Open is him acting on it: open the link and stop the ring.
      onOpen: (id, link) => {
        if (/^https?:\/\//i.test(link)) void shell.openExternal(link)
        void wakeupService?.ack(id, me())
      },
      flash: (on) => {
        if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.flashFrame(on)
      },
      volume: () => settings.get().wakeupVolume,
      snoozeMinutes: () => settings.get().wakeupSnoozeMinutes,
      proof: process.env['AGENT_WAKEUP_PROOF'] === '1',
      log: (message, detail) => logger.info(message, detail),
    })
    wakeupService = new WakeupService({
      store: wakeStore,
      onChange: (listener) => wakeStore.onChange(listener),
      selfId: () => devicesState.sync?.selfId() ?? '',
      selfName: () => settings.get().deviceName,
      selfRings: () => settings.get().wakeupsRingHere,
      pauseUntil: () => settings.get().wakeupsPauseHereUntil,
      idleRule: () => settings.get().wakeupsPhoneOnlyWhenIdle,
      idleState: wakeIdleState(settings),
      devices: async () => (await wakeStore.list('device')).filter((d) => !d.revoked).map((d) => ({ id: d.id, name: d.name, kind: d.kind })),
      settings: () => ({ snoozeMinutes: settings.get().wakeupSnoozeMinutes, quietHours: settings.get().wakeupQuietHours }),
      idleSeconds: () => {
        try {
          return powerMonitor.getSystemIdleTime()
        } catch {
          return null
        }
      },
      ringer: ring,
      broadcast: (snapshot) => getDevicesHost()?.emit(null, WAKEUP_RPC.changed, snapshot),
      emitEvent: (input) => {
        const stored = workers.addEvent(input.source, input)
        if (stored !== null) void eventRouter?.offer(stored)
        workersChanged(input.source)
      },
      log: (message, detail) => logger.info(message, detail),
    })
    setWakeups(wakeupService)
    wakeupService.start()
    registerWakeupIpc(ipcMain, {
      service: getWakeups,
      reports: wakeReports,
      nameOf: async (id) => (await wakeStore.get('device', id))?.name ?? 'a device',
      selfName: () => settings.get().deviceName,
      devices: async () =>
        (await wakeStore.list('device'))
          .filter((d) => !d.revoked && d.kind !== 'server' && d.id !== (devicesState.sync?.selfId() ?? ''))
          .map((d) => ({ id: d.id, name: d.name, kind: d.kind, appVersion: d.facts?.appVersion ?? '' })),
      reachable: (id) => getDevicesHost()?.wakeReachable?.(id) ?? false,
    })
    settings.onChange(() => wakeupService?.kick())
    // Locked or back: look at once rather than at the next poll.
    for (const event of ['lock-screen', 'unlock-screen', 'resume'] as const) powerMonitor.on(event as 'resume', () => wakeupService?.kick())
  }
  const tools = buildToolset({
    git: { kv: gitKv, hook: () => gitHook },
    appControl: { ...appControl, update: selfUpdater },
    calendar: () => presenceHandle?.calendar ?? null,
    miniappUi: () => miniappUi,
    media: {
      show: (path) => shownMedia.show(path),
      selfId: () => devicesState.sync?.selfId() ?? '',
      origin: async (chat) => (store === null ? null : latestOrigin(store, chat)),
    },
    presence,
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
    workers: workerTools,
    vault,
    browserVault,
    recordings,
    searchChats: async (query, limit) => (memory === null ? [] : memory.searchChats(query, limit)),
    deviceHub: () => devicesState.sync?.tools ?? null,
    devices: {
      selfId: () => devicesState.sync?.selfId() ?? '',
      commands: () => devicesState.sync?.commands ?? null,
      openLocal: (url) => {
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      },
    },
    projects: {
      agents: projectAgents,
      post: async (chat, text, via) => {
        if ((await offloadWire?.forward(chat, text, via)) === true) return
        if (runner !== null) await runner.receive(chat, text, via)
      },
      place: async (chat, project, brief, device) => offloadWire?.placeChat(chat, project, brief, device),
      state: (chat) => runner?.state(chat) ?? { running: false, waiting: [] },
      agentName: () => settings.get().agentName,
      profiles: () => apps.profiles.all(),
      accounts: () => accounts.all(),
      // project_open: the window shows the project's page (renderer state/keys.ts listens for the route).
      open: (projectId) => broadcast(EVENTS.route, { view: 'project', id: projectId }),
      imageIcon: async (path) => {
        const picture = nativeImage.createFromPath(path)
        if (picture.isEmpty()) return null
        const { width, height } = picture.getSize()
        // Square from the middle, then down to icon size.
        const side = Math.min(width, height)
        const square = picture.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
        return square.resize({ width: ICON_IMAGE_PX, height: ICON_IMAGE_PX, quality: 'best' }).toDataURL()
      },
    },
  })
  eventRouter = new EventRouter({
    store,
    workers,
    desk: helpers,
    maxRuns: () => settings.get().routinesAtOnce,
    onChange: () => workersChanged(),
    workerName: (id) => {
      try {
        return workers.manifest(id)?.name ?? id
      } catch {
        return id
      }
    },
    onFailed: (trigger, why) => {
      showNotification(`Routine could not run: ${trigger.name}`, why.slice(0, 200))
      void workerNotice(`Routine "${trigger.name}" could not hand its events to its desk: ${why.slice(0, 300)}. Its events are kept as failed; Run now on the Routines page tries them again.`)
    },
  })
  runner = new Runner({
    dataDir: dir,
    devices: {
      leases,
      shellFor: (chat) => offloadWire?.shellFor(chat),
      selfOrigin: () => devicesState.sync?.selfOrigin() ?? null,
      originLine: async (chat) => (await devicesState.sync?.originLine(chat)) ?? '',
    },
    presence,
    git: gitHook,
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
    locks: brainLocks,
    profiles: () => ({ profiles: apps.profiles.all(), learnedNames: learnedNames() }),
    environment: () => environment.current(),
    providerFactory: factory,
    notify: showNotification,
    notifyCard: (itemId, title, body) => notifier.needsYou(itemId, title, body),
    // A finished reply while the window is not in front of the person: one notification per chat, replaced not stacked.
    notifyReply: (chat, body) => notifier.replyFinished(chat, settings.get().agentName, body),
    emit: (event) => {
      broadcast(EVENTS.chat, event)
      tray?.refresh()
    },
    isFocused: () => mainWindow?.isFocused() ?? false,
    // Files the person attached may be opened by the agent without another ask, like files they picked.
    allowFiles: (paths) => {
      for (const path of paths) filePicks.add(path)
    },
  })
  // Mini-apps (docs/plans/mini-apps.md): the apps agents made, served sandboxed, their bridge run here, looked at
  // offscreen in both themes and widths before he sees them.
  {
    const maStore = store
    const miniapps = new MiniAppStore({ store: maStore, knownTools: () => new Set(helperToolset.map((tool) => tool.spec.name)) })
    const filesOf = async (id: string): Promise<Record<string, string> | null> => (await maStore.get('miniapp', id))?.files ?? null
    const font = rendererFonts(join(__dirname, '../renderer'))
    miniappHost = new MiniAppHost({
      apps: miniapps,
      onRowsChange: (listener) => maStore.onChange(listener),
      runTool: async (row, name, args, signal) => {
        const tool = helperToolset.find((item) => item.spec.name === name)
        if (tool === undefined || runner === null) throw new Error(`There is no ${name} here.`)
        const base = runner.deviceToolContext(signal)
        return tool.run(args, {
          ...base,
          agentLabel: `app ${row.name}`,
          owner: `miniapp:${row.id}`,
          ...(row.profile === '' ? {} : { profile: row.profile }),
          activity: async () => 0,
          updateActivity: async () => undefined,
        })
      },
      approve: async (_row, summary, details, signal) => (runner === null ? false : runner.deviceContext(MAIN_CHAT, signal).approve(summary, details)),
      // A learned app's tool marked read_only runs without a card, like a Composio read.
      reads: (name, args) => {
        if (name !== 'webapp_run') return null
        const saved = learned.find(String(args['app'] ?? ''))
        const tool = saved?.tools.find((each) => each.name === String(args['tool'] ?? '').trim())
        return tool === undefined ? null : tool.readOnly
      },
      ask: async (row, text) => {
        await runner?.send(`(From my mini-app "${row.name}") ${text}`)
      },
      // agent.openUrl and link clicks: checked https links in his default browser (or the app that owns the link).
      openUrl: (url) => shell.openExternal(url),
      onCalendarChange: (listener) => presenceHandle?.calendar.onChange(listener) ?? (() => undefined),
      log: (message, detail) => logger.info(message, detail),
    })
    setMiniAppHost(miniappHost)
    void miniappHost.start().then(() => logger.info('Mini-apps started', { engine: miniappHost?.engine.kind ?? 'off' }))
    serveMiniAppsIn(electronSession.defaultSession, filesOf, font)
    // Only this window's session can reach a shown file, and only the ones an agent showed.
    serveMediaIn(electronSession.defaultSession, (token) => shownMedia.get(token))
    guardMiniAppFrames(win.webContents, electronSession.defaultSession, (message, detail) => logger.info(message, detail))
    const checker = new MiniAppChecker({
      host: () => miniappHost,
      filesOf,
      font,
      preload: join(__dirname, '../preload/miniapp-check.js'),
      outDir: join(dir, 'miniapps', 'checks'),
      accent: () => settings.get().accent,
      log: (message, detail) => logger.info(message, detail),
    })
    // One look per app version, whoever asks (a tool, the window, or a version that arrived from another device).
    const checking = new Map<string, Promise<MiniAppCheck>>()
    const ensureChecked = (row: MiniAppRow): Promise<MiniAppCheck> => {
      const key = `${row.id}:${row.version}`
      const running = checking.get(key)
      if (running !== undefined) return running
      const run = checker.check(row).then(async (result) => {
        await miniapps.setCheck(row.id, result)
        return result
      }).finally(() => checking.delete(key))
      checking.set(key, run)
      return run
    }
    miniappUi = {
      open: async (row) => {
        showMainWindow()
        broadcast(MINIAPP_EVENTS.open, row.id)
      },
      check: ensureChecked,
    }
    maStore.onChange((change) => {
      if (change.entity !== 'miniapp' || change.reset === true || change.row === undefined) return
      const row = change.row as MiniAppRow
      // A new version from another device (or the headless node) is looked at here before it is shown.
      if (row.check.version !== row.version && !checking.has(`${row.id}:${row.version}`)) setTimeout(() => void ensureChecked(row).catch(() => undefined), 3000)
    })
    registerMiniAppIpc(ipcMain, {
      host: () => miniappHost,
      apps: miniapps,
      push: (sessionId, message) => broadcast(MINIAPP_EVENTS.push, [sessionId, message]),
      check: async (id) => {
        const row = await miniapps.find(id)
        return row === null ? null : ensureChecked(row)
      },
      askChange: async (id, name, text) => {
        await runner?.send(`Change my mini-app "${name}" (${id}): ${text}`)
      },
    })
    miniappRpc = (devicesHost) => registerMiniAppRpc(devicesHost, { host: () => miniappHost, apps: miniapps })
  }
  offloadWire = startOffload({
    store,
    helpers,
    settings,
    secrets,
    providerFactory: factory,
    cli: cliHost,
    runner: () => runner,
    kind: 'desktop',
    name: () => settings.get().deviceName,
    browser: () => true,
    emitChat: (event) => broadcast(EVENTS.chat, event),
    needsYou: (itemId, title, body) => notifier.needsYou(itemId, title, body),
    log: (message, detail) => logger.info(message, detail),
  })
  const placedWire = offloadWire
  // The start-up repairs each read the whole chat; they run once the window has painted, not before it.
  // Routines start only once the start-up repair has run (28 Oct 2026: a routine started first, and the repair then
  // marked its fresh card failed as if the app had closed under it; it ran on unseen).
  let markRepaired: () => void = () => undefined
  const repaired = new Promise<void>((resolve) => {
    markRepaired = resolve
  })
  const repairs = async (): Promise<void> => {
    if (store === null || runner === null) {
      markRepaired()
      return
    }
    try {
      // Old chats from before projects sit under a hidden "Earlier chats" project (projects/earlier.ts).
      await adoptEarlierChats(store, store.deletedIds('project').has(EARLIER_CHATS_PROJECT))
    } catch {
      // The chats are still in the store; they show up once this succeeds on a later start.
    }
    try {
      await runner.restore()
    } catch {
      // Startup repair is best effort: the app must still open if a row cannot be rewritten.
    }
    markRepaired()
    void projectAgents.restore().catch(() => undefined)
    // After the repairs: what a crash cut off runs again, once (runtime/turns.ts).
    void leases?.recover().catch(() => 0)
    // Back from an update the agent started (app_update): it hears so in the chat that asked, and carries on.
    const updated = selfUpdater.resume()
    if (updated !== null) {
      logger.info('Update finished', {
        from: updated.from,
        now: updated.now,
        ok: updated.ok,
        installed: updated.result?.installedVersion ?? null,
        installerExit: updated.result?.installerExit ?? null,
        reason: updated.reason,
      })
      void runner?.deliver(resumeNote(updated), updated.chat).catch(() => undefined)
    }
    // Helpers left working are now marked interrupted, so desks can start: anything that arrived meanwhile,
    // or was cut short when the app closed, goes to its routine now.
    try {
      await eventRouter?.start()
    } catch (error) {
      logger.warn('Event router did not start', { message: error instanceof Error ? error.message : String(error) })
    }
  }
  if (isSmoke) await repairs()
  else win.webContents.once('did-finish-load', () => setTimeout(() => void repairs(), 250))

  // Long-term memory: New Chat files the old chat in the background, past chats are searchable, and the
  // end-of-day pass writes "Where we are" and cleans up (main/memory).
  chatIndex = new ChatIndex(join(dir, 'chat-search.db'))
  const memoryStore = store
  const upkeep = new UpkeepFile(join(dir, 'memory-upkeep.json'))
  // End of day is a routine on the Routines page, created once from the old Memory setting; deleted stays deleted.
  try {
    await ensureDailyRoutine(memoryStore, {
      dailyAt: settings.get().dailyMemoryAt,
      lastReport: upkeep.read().report,
      deleted: store.deletedIds('trigger').has(MEMORY_DAILY_ROUTINE),
    })
  } catch {
    // Without the row the pass simply does not run on its own; the app must still open.
  }
  memory = new MemoryService({
    store: memoryStore,
    index: chatIndex,
    upkeep,
    complete: (system, prompt, signal) => {
      if (runner === null) return Promise.reject(new Error('The agent is not running.'))
      return runner.oneShot(system, prompt, signal)
    },
    forgetSession: (thread) => cliHost?.forget(thread),
    emitChat: () => broadcast(EVENTS.chat, { type: 'chat_changed' }),
    emitUpkeep: (report) => broadcast(MEMORY_EVENTS.upkeep, report),
    dailyAt: () => dailyRoutineSlot(memoryStore),
    onDaily: (report) => recordDailyRun(memoryStore, report),
    claimDaily: (day) => placedWire.claimDaily(day),
    log: (message, detail) => logger.info(message, detail),
  })
  // Tidying a memory bank with the agent (Settings > Memory > Import), on the same model as chat filing.
  const memoryTidy = new MemoryTidy({
    store: memoryStore,
    complete: (system, prompt, signal) => {
      if (runner === null) return Promise.reject(new Error('The agent is not running.'))
      return runner.oneShot(system, prompt, signal)
    },
    upkeep,
    file: new TidyFile(join(dir, 'memory-tidy.json')),
    emit: (progress) => broadcast(MEMORY_EVENTS.tidy, progress),
    log: (message, detail) => logger.info(message, detail),
  })
  registerMemoryIpc({
    ipcMain,
    service: memory,
    store: memoryStore,
    pickFile: pickImportFile,
    log: (message, detail) => logger.info(message, detail),
    tidy: memoryTidy,
  })
  registerMemoryHistoryIpc(ipcMain, memoryStore)
  void memory.restore().catch(() => undefined)
  memory.start()

  scheduler = new Scheduler({
    store,
    runner,
    notifyRoutine: (triggerId, name, result) => notifier.routineResult(triggerId, name, result),
    runBuiltin: async (trigger) => {
      if (trigger.builtin !== MEMORY_DAILY_ROUTINE || memory === null) throw new Error('That routine cannot run here.')
      return { text: resultLine(await memory.runNow()), waiting: false }
    },
    runEvent: async (trigger) => {
      if (eventRouter === null) throw new Error('Event routines are not ready yet.')
      return eventRouter.runNow(trigger)
    },
    claim: (trigger) => placedWire.claimRoutine(trigger),
  })
  // Background scripts show as runs with a stop, and end with the routine or helper that started them.
  const scriptStore = store
  watchBackgroundScripts(scriptStore, () => broadcast(EVENTS.chat, { type: 'chat_changed' }))
  const startScheduler = scheduler
  void Promise.race([repaired, new Promise<void>((resolve) => setTimeout(resolve, 120_000))]).then(() => startScheduler.start())
  // Workers come back on every start; each one catches up from its cursor on what it missed while closed.
  supervisor.start()
  registerWorkersIpc(ipcMain, { store: workers, supervisor, openPath: (path) => shell.openPath(path) })
  registerVaultIpc(ipcMain, { vault, clipboard: { write: (text) => clipboard.writeText(text), read: () => clipboard.readText() } })

  const paths = quickAskPaths(__dirname)
  quickAsk = new QuickAskWindow({
    ...paths,
    devUrl: process.env['ELECTRON_RENDERER_URL'],
    keepOpen: () => dictation !== null && dictation.controller.phase !== 'idle',
    onWindow: (window) => capturePrivacy?.register(window, 'chat'),
  })
  hotkeys = new HotkeyManager(
    globalShortcut,
    {
      quickAsk: openQuickAsk,
      dictate: () => dictation?.controller.toggle('plain'),
      dictateClean: () => dictation?.controller.toggle('clean'),
    },
    (statuses) => {
      lastHotkeyStatuses = statuses
      for (const status of statuses) broadcast(EVENTS.hotkey, status)
      const failed = statuses.filter((status) => !status.ok).map((status) => status.action ?? '')
      if (failed.length > 0) logger.warn('Shortcuts not registered', { actions: failed.join(',') })
      void explainBlockedHotkeys()
    },
  )
  // A shortcut another app holds starts working by itself once that app lets go: checked every 25 s, when the
  // main window gains focus, and after sleep or unlock.
  hotkeyRetry = setInterval(retryHotkeys, 25_000)

  let lastSettings = settings.get()
  disposeSettings = settings.onChange((next) => {
    // Which settings changed (names only, never values), so a setting that will not stick can be traced.
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(lastSettings[key]))
    lastSettings = next
    if (changed.length > 0) logger.info('Settings changed', { keys: changed.join(',') })
    if (changed.includes('shell') && next.shell === 'always') void runner?.approveComputerCards()
    if (changed.includes('theme') || changed.includes('accent')) void agentBrowser?.restyleGuides()
    if (changed.includes('hideGuidesFromCapture') || changed.includes('hideChatFromCapture')) {
      capturePrivacy?.apply()
      void agentBrowser?.refreshGuidePrivacy()
    }
    applyLoginItem(next)
    applyHotkey(next)
    tray?.refresh()
  })

  disposeIpc = registerIpc({
    ...(recordingsStore === null ? {} : { recordings: recordingsStore }),
    store,
    settings,
    secrets,
    accounts,
    account,
    chat: placedWire.wrapRunner(runner),
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
    pasted: {
      save: async (name, mime, bytes) => {
        const saved = savePastedFile(join(app.getPath('userData'), 'attachments'), name, mime, bytes)
        filePicks.add(saved.path)
        return saved
      },
      clipboardFiles: () => clipboardAttachments(clipboard),
    },
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
  allowMicrophone(win.webContents.session, (id) => id === win.webContents.id || dictation?.pill.isPill(id) === true)
  voice = new VoiceService({
    secrets,
    settings,
    store,
    runner,
    emit: (event) => broadcast(EVENTS.voiceCall, event),
    platform: process.platform,
    environment: () => environment.current(),
    notesDir: join(app.getPath('userData'), 'voice-notes'),
    ...(recordingsStore === null ? {} : { recordings: recordingsStore }),
  })
  // A linked phone's call hands its work to the main agent, a project chat or a helper here (main/voice/handoff.ts).
  const callStore = store
  const callRunner = runner
  const callHelpers = helpers
  const callFeed = new HelperFeed({ store: callStore, emit: () => undefined })
  registerVoiceIpc(voice, ipcMain, {
    store: callStore,
    send: (text, chat, origin, via) => callRunner.send(text, [], chat, origin as never, via),
    steer: (id, message) => callHelpers.steer(id, message),
    cards: () => callFeed.snapshot(),
    state: (chat) => callRunner.state(chat),
    agentName: () => settings.get().agentName,
    delegated: (chat, project, brief) => projectAgents.delegated(chat, project, brief),
  })

  // Dictation anywhere: the pill window holds the microphone, the words are typed into the app in front.
  const voiceService = voice
  dictation = createDictation({
    voice: voiceService,
    geminiKey: () => secrets.get('geminiKey'),
    hotkeys: () => hotkeys,
    pill: { ...quickAskPaths(__dirname), devUrl: process.env['ELECTRON_RENDERER_URL'] },
    locale: app.getLocale(),
    log: (message, fields) => logger.info(message, fields),
    vocabulary: async () => (store === null ? EMPTY_VOCABULARY : vocabularyFrom(await store.list('memory'))),
    extraWords: async () => {
      const own = [settings.get().userName, settings.get().agentName].filter((name) => name.trim() !== '' && name !== DEFAULT_SETTINGS.agentName)
      if (store === null) return own
      return [...own, ...dictationWordsFromProjects(await store.list('project')).slice(0, 30)]
    },
    ...(recordingsStore === null ? {} : { recordings: recordingsStore }),
  })
  // A recording the last run left unfinished (a crash, an update's restart) is finished from what is on disk, he is
  // told once in its chat, and audio the keep setting no longer keeps is deleted; then again every night.
  if (recordingsStore !== null) {
    const noticeStore = store
    recordingsUpkeep = startRecordingsUpkeep({
      recordings: recordingsStore,
      keep: () => settings.get().recordingAudioKeep,
      transcribe: () => (voiceService.hasKey() && dictation !== null ? dictation.transcribe : null),
      notify: async (notice) => {
        await noticeStore.upsert('chat_item', {
          kind: 'notice',
          text: recoveredNoticeText(notice),
          meta: JSON.stringify({ ...chatTag(notice.chat ?? MAIN_CHAT), recording: notice.id }),
        })
        broadcast(EVENTS.chat, { type: 'chat_changed', ...chatTag(notice.chat ?? MAIN_CHAT) })
      },
      log: (message, fields) => logger.info(message, fields),
    })
    // Recordings the last run left behind have their words now: the message box offers back any never added.
    void recordingsUpkeep.done.then(() => dictation?.undeliveredChanged())
  }
  registerDictationIpc(
    {
      hotkeyStatus: () => hotkeys?.status() ?? [],
      pauseHotkeys: (paused) => hotkeys?.pause(paused),
      audio: (session, pcm) => dictation?.controller.audio(session, pcm),
      micState: (session, ok, message) => dictation?.controller.micState(session, ok, message),
      stop: () => dictation?.controller.stop(),
      pillReady: () => dictation?.pill.rendererReady(),
      toggle: (sender, mode, chat) => {
        if (dictation === null) return
        if (sender !== null && typeof sender === 'object' && 'id' in sender) dictation.toggleFrom(sender as Electron.WebContents, mode, chat)
        else dictation.controller.toggle(mode)
      },
      cancel: () => dictation?.controller.cancel(),
      retry: () => void dictation?.controller.retry(),
      current: (sender) => dictation?.currentFor(sender) ?? null,
      boxResult: (sender, id, ok) => dictation?.boxResult(sender, id, ok),
      undelivered: async () => (await recordingsStore?.undelivered()) ?? [],
      flushDrafts: (sender) => (sender as Electron.WebContents | null)?.session?.flushStorageData(),
      settle: async (id, how) => {
        await recordingsStore?.setDelivery(id, how)
        logger.info('Dictation offered back: settled', { id, how })
        dictation?.undeliveredChanged()
      },
    },
    ipcMain,
  )
  // Warm the pill and the paste helper a little after start, so the first dictation is quick.
  setTimeout(() => {
    if (settings.get().dictateHotkey.trim() === '' && settings.get().dictateCleanHotkey.trim() === '') return
    dictation?.pill.prepare()
    dictation?.keys?.warm()
  }, 4000)

  applyLoginItem(settings.get())

  // Devices: this computer as a node other devices pair with (main/devices). Off until switched on in Settings.
  try {
    devices = new DevicesService({
      userData: dir,
      store,
      secrets,
      registry: handlerRegistry,
      appVersion: app.getVersion(),
      nodeName: () => settings.get().deviceName,
      platform: process.platform,
      ready: () => settings.get().mode !== 'none' || settings.get().accounts.length > 0,
      busy: () => runner?.state().running ?? false,
      rendererDir: join(__dirname, '../renderer'),
      emitWindow: (channel, payload) => broadcast(channel, payload),
      log: (message, detail) => logger.info(message, detail),
      // The optional overlay helper (devices/net.ts): packaged next to the app, or the repo's build in development.
      sidecar: () => findSidecar({ resourcesPath: app.isPackaged ? process.resourcesPath : undefined, dirs: app.isPackaged ? [] : [join(app.getAppPath(), '..', '..')] }),
      // This computer lends its own tools to the agents on other devices (protocol s11), group by group.
      deviceTools: new DeviceToolHost({
        tools: () => tools,
        context: (signal) => {
          if (runner === null) throw new Error('The agent is not running.')
          return runner.deviceToolContext(signal)
        },
        shared: () => devices?.shareGroups() ?? DEFAULT_SHARE,
        inbox: join(dir, 'attachments', 'received'),
        log: (message, detail) => logger.info(message, detail),
      }),
      firewall: new WindowsFirewall({ platform: process.platform, program: process.execPath }),
      openUrl: (url) => shell.openExternal(url),
      notify: showNotification,
    })
    devices.registerIpc(ipcMain)
    setDevicesService(devices)
    // While Devices is on: replication, the bundle, device commands, shared tools, turn failover (devices/attach.ts).
    if (devicesAppHooks !== null) {
      const hooks = devicesAppHooks
      const ready = devices
      disposeDevicesSync = attachDevicesSync(ready, {
        store,
        bundle: {
          settings,
          secrets,
          profiles: apps.profiles,
          learned,
          connected: connectedApps,
          ...(vaultStore === null ? {} : { vault: vaultStore }),
          passes: ready.passTable(),
          projects: () => store === null ? Promise.resolve([]) : store.list('project'),
        },
        ...hooks,
        imageDir: join(dir, 'attachments', 'from-devices'),
        log: (line) => logger.info(line),
      })
    }
    // A page this computer fetches for the person's other nodes (a server a site blocks): relay.fetch.
    registerRelay(devices.host(), { store, rolesOf: rolesFromStore(store) })
    // A file an agent showed plays on his phone too: the same list, by token, one range at a time (media/fetch.ts).
    registerMediaFetch(devices.host(), { get: (token) => shownMedia.get(token) })
    // Wake-ups: the phone's ringing screen and wake channel answer and report here (main/wakeups/bridge.ts).
    {
      const wakeStore = store
      registerWakeupRpc(devices.host(), { service: getWakeups, reports: wakeReports, nameOf: async (id) => (wakeStore === null ? 'a device' : ((await wakeStore.get('device', id))?.name ?? 'a device')) })
    }
    // Mini-apps: the phone shows them in its WebView and runs their bridge here (main/miniapps/ipc.ts).
    miniappRpc?.(devices.host())
    await devices.start()
  } catch (error) {
    logger.error('Devices could not start', { message: error instanceof Error ? error.message : String(error) })
  }
}

// Agents browse with the panel hidden and the window minimised: their pages must keep running (browser/keep-awake.ts).
// One honest Chrome user agent for the whole app, set before any window exists. A session-level or debugger
// user agent only reaches the top frame: a Worker or a Service Worker still reported the Electron and app tokens
// (measured 6 Nov 2026), which a human-verification challenge reads.
app.userAgentFallback = fallbackUserAgent()

keepPagesAwake(app.commandLine)

if (refuseToStart) {
  // handed over or explained above; app.exit is on its way
} else if (!app.requestSingleInstanceLock()) {
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
      supervisor?.resume()
      retryHotkeys()
    })
    powerMonitor.on('unlock-screen', retryHotkeys)
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
    presenceHandle?.stop()
    presenceHandle = null
    wakeupService?.stop()
    wakeupService = null
    setWakeups(null)
    void miniappHost?.stop()
    miniappHost = null
    miniappUi = null
    setMiniAppHost(null)
    recordingsUpkeep?.stop()
    recordingsUpkeep = null
    eventRouter?.stop()
    eventRouter = null
    // Every worker is told to stop and its process tree ended; its stop time is saved so it catches up next start.
    supervisor?.stopAll()
    supervisor = null
    workerStore?.close()
    workerStore = null
    memory?.stop()
    memory = null
    chatIndex?.close()
    chatIndex = null
    tray?.destroy()
    tray = null
    quickAsk?.destroy()
    quickAsk = null
    if (hotkeyRetry !== null) clearInterval(hotkeyRetry)
    hotkeyRetry = null
    hotkeys?.dispose()
    hotkeys = null
    dictation?.dispose()
    dictation = null
    globalShortcut.unregisterAll()
    void voice?.callEnd()
    voice = null
    void devices?.stop()
    devices = null
    setDevicesService(null)
    // Helpers still working stay marked working: the next start ends them and tells their creators.
    helperManager?.shutdown()
    helperManager = null
    runner?.dispose()
    leases?.stop()
    disposeDevicesSync?.()
    disposeDevicesSync = null
    devicesState.sync?.stop()
    runner = null
    agentBrowser?.destroy()
    agentBrowser = null
    account?.dispose()
    account = null
    store?.close()
    store = null
    resourceMonitor?.stop()
    resourceMonitor = null
    watchdog?.stop()
    watchdog = null
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
