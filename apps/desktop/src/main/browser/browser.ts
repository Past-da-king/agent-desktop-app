/**
 * The agent's own browser: one WebContentsView per tab, attached to the chat panel's rectangle in
 * the main window. It has its own session partition, so it is separate from the app UI and keeps
 * its sign-ins across runs.
 *
 * Two modes:
 *   - the agent drives (the default): the person's mouse and keyboard are ignored, and only public
 *     web addresses may be opened;
 *   - the person drives (browser_handoff or the panel's Take over): input works and private or
 *     local addresses are allowed, because a human asked for them.
 *
 * Page helpers live in ./outline.ts as plain JavaScript so they can be tested in a real Chromium.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { shell, WebContentsView } from 'electron'
import type { BrowserWindow, DownloadItem, Session } from 'electron'

import type { BrowserBounds, BrowserState, BrowserTab } from '@agent/core'

import type { BrowserDriver } from './types'
import { checkBrowserUrl } from './url-policy'
import {
  PAGE_WORLD_ID,
  clickScript,
  formatOutline,
  outlineScript,
  parseAction,
  parseOutline,
  parseRead,
  readScript,
  scrollScript,
  typeScript,
  uploadScript,
  waitForScript,
  type ReadTarget,
} from './outline'

const PARTITION = 'persist:agent-browser'
const MAX_TABS = 5
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024
const EMPTY_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 0, height: 0, visible: false }

interface Tab {
  id: string
  view: WebContentsView
}

export interface AgentBrowserOptions {
  window: BrowserWindow
  partition?: string
  maxTabs?: number
  onState?: (state: BrowserState) => void
  openExternal?: (url: string) => Promise<void>
  tempRoot?: string
}

export class AgentBrowser implements BrowserDriver {
  private window: BrowserWindow | null
  private readonly partition: string
  private readonly maxTabs: number
  private readonly onState: (state: BrowserState) => void
  private readonly openExternal: (url: string) => Promise<void>
  private readonly runDir: string
  private readonly downloadsDir: string
  private readonly screenshotsDir: string
  private readonly tabs: Tab[] = []
  private readonly inputCss = new Map<string, string>()
  private readonly downloads: string[] = []
  private readonly sessionCleanups: Array<() => void> = []

  private activeId: string | null = null
  private bounds: BrowserBounds = { ...EMPTY_BOUNDS }
  private agentDriving = true
  private handoffReason = ''
  private blockedReason = ''
  private sessionReady = false
  private injectingInput = false
  private tabSeq = 0
  private shotSeq = 0
  private destroyed = false

  constructor(options: AgentBrowserOptions) {
    this.window = options.window
    this.partition = options.partition ?? PARTITION
    this.maxTabs = Math.max(1, options.maxTabs ?? MAX_TABS)
    this.onState = options.onState ?? (() => undefined)
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))

    const root = options.tempRoot ?? tmpdir()
    this.runDir = mkdtempSync(join(root, 'agent-browser-'))
    this.downloadsDir = join(this.runDir, 'downloads')
    this.screenshotsDir = join(this.runDir, 'screenshots')
    mkdirSync(this.downloadsDir, { recursive: true })
    mkdirSync(this.screenshotsDir, { recursive: true })

    this.attach(options.window)
  }

  // ---- the person's side ------------------------------------------------------------------

  setBounds(bounds: BrowserBounds): void {
    this.bounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
      visible: bounds.visible === true,
    }
    this.layout()
    this.emit()
  }

  state(): BrowserState {
    const active = this.activeTab()
    const tabs: BrowserTab[] = this.tabs.map((tab) => ({
      id: tab.id,
      title: safeTitle(tab.view),
      url: safeUrl(tab.view),
      active: tab.id === this.activeId,
    }))
    return {
      url: active === null ? '' : safeUrl(active.view),
      title: active === null ? '' : safeTitle(active.view),
      tabs,
      visible: this.bounds.visible,
      agentActive: this.agentDriving,
      needsUser: this.handoffReason !== '',
      handoffReason: this.handoffReason,
    }
  }

  async back(): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    const wc = tab.view.webContents
    if (!wc.navigationHistory.canGoBack()) return 'There is no earlier page.'
    wc.navigationHistory.goBack()
    await this.waitForLoad(tab)
    this.emit()
    return this.snapshot()
  }

  async reload(): Promise<void> {
    const tab = this.activeTab()
    if (tab === null) return
    tab.view.webContents.reload()
    this.emit()
  }

  selectTab(id: string): void {
    if (!this.tabs.some((tab) => tab.id === id)) return
    this.activeId = id
    this.layout()
    this.emit()
  }

  closeTab(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    const [tab] = this.tabs.splice(index, 1)
    if (tab === undefined) return
    this.inputCss.delete(tab.id)
    try {
      this.window?.contentView.removeChildView(tab.view)
    } catch {
      // The window may already be gone.
    }
    try {
      tab.view.webContents.close()
    } catch {
      // Already closed.
    }
    if (this.activeId === id) {
      this.activeId = this.tabs[Math.max(0, index - 1)]?.id ?? this.tabs[0]?.id ?? null
      this.layout()
    }
    this.emit()
  }

  takeOver(): void {
    this.setAgentDriving(false, '')
  }

  giveBack(): void {
    this.setAgentDriving(true)
  }

  async openInSystem(): Promise<void> {
    const tab = this.activeTab()
    if (tab === null) return
    const url = safeUrl(tab.view)
    if (!/^https?:\/\//i.test(url)) return
    await this.openExternal(url)
  }

  attach(win: BrowserWindow): void {
    if (this.window === win) {
      this.layout()
      return
    }
    this.detach()
    this.window = win
    for (const tab of this.tabs) {
      try {
        win.contentView.addChildView(tab.view)
      } catch {
        // A view can only belong to one window; a fresh one is created on the next open.
      }
    }
    this.layout()
    this.emit()
  }

  detach(): void {
    if (this.window === null) return
    for (const tab of this.tabs) {
      try {
        this.window.contentView.removeChildView(tab.view)
      } catch {
        // Already removed.
      }
    }
    this.window = null
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const cleanup of this.sessionCleanups.splice(0)) {
      try {
        cleanup()
      } catch {
        // A session listener that cannot be removed is harmless at shutdown.
      }
    }
    this.detach()
    for (const tab of this.tabs.splice(0)) {
      try {
        tab.view.webContents.close()
      } catch {
        // Already closed.
      }
    }
    try {
      rmSync(this.runDir, { recursive: true, force: true })
    } catch {
      // Temporary files are cleaned by the OS eventually.
    }
  }

  // ---- the tools' side --------------------------------------------------------------------

  hasPage(): boolean {
    const tab = this.activeTab()
    return tab !== null && isRealPage(tab.view)
  }

  currentUrl(): string {
    const tab = this.activeTab()
    return tab === null ? '' : safeUrl(tab.view)
  }

  /**
   * Runs script text in the page's main world, for learned apps (reference phone PageJs.direct): the
   * app injects the text itself, so the site's content security policy does not stop it. A promise
   * result is awaited. Rejects on a syntax error, a thrown error or the timeout.
   */
  async evaluate(code: string, timeoutMs = 30_000): Promise<unknown> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) throw new Error('No page is open yet. Use browser_open with a web address.')
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`The page did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs)
    })
    try {
      return await Promise.race([tab.view.webContents.executeJavaScript(code, true), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async open(raw: string): Promise<string> {
    const policy = checkBrowserUrl(raw)
    if (!policy.ok) return policy.reason
    const tab = this.activeTab() ?? this.createTab()
    if (tab === null) return 'I could not open another browser tab.'

    this.blockedReason = ''
    const wc = tab.view.webContents
    const previous = safeUrl(tab.view)
    try {
      await wc.loadURL(policy.url)
    } catch {
      // A blocked redirect or a site that never answers: report what is actually on screen.
      if (safeUrl(tab.view) === previous && previous === '') {
        return `I could not open ${hostOf(policy.url)}.`
      }
    }
    await this.settle(300)
    this.emit()
    return this.snapshot()
  }

  async snapshot(): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    const raw = await this.run(tab, outlineScript())
    const outline = parseOutline(raw)
    if (this.blockedReason !== '') {
      outline.note = outline.note === '' ? this.blockedReason : `${outline.note} ${this.blockedReason}`
      this.blockedReason = ''
    }
    return formatOutline(outline, this.downloads.slice(-5))
  }

  async read(target: ReadTarget = {}): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    const result = parseRead(await this.run(tab, readScript(target)))
    if (!result.ok) return result.reason
    const head = `URL: ${safeUrl(tab.view)}\nTitle: ${safeTitle(tab.view)}\n\n`
    return `${head}${result.text === '' ? '(no text)' : result.text}`
  }

  async click(index: number): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    const result = parseAction(await this.run(tab, clickScript(index)))
    if (!result.ok) return result.reason
    await this.settle(450)
    this.emit()
    return `Clicked ${result.label}.\n\n${await this.snapshot()}`
  }

  async type(index: number, text: string, submit: boolean): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    const result = parseAction(await this.run(tab, typeScript(index, text)))
    if (!result.ok) return result.reason
    if (submit) {
      this.pressKey(tab, 'Enter')
      await this.settle(550)
      this.emit()
      return `Typed into ${result.label} and pressed Enter.\n\n${await this.snapshot()}`
    }
    await this.settle(150)
    return `Typed into ${result.label}.`
  }

  async press(key: string): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    this.pressKey(tab, key)
    await this.settle(350)
    this.emit()
    return `Pressed ${key}.\n\n${await this.snapshot()}`
  }

  async scroll(dy: number): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    await this.run(tab, scrollScript(dy))
    await this.settle(200)
    return this.snapshot()
  }

  async waitFor(
    query: { text: string; selector: string },
    seconds: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    if (signal?.aborted === true) return 'Stopped.'
    const wait = this.run(tab, waitForScript(query.text, query.selector, seconds * 1000))
    const value = await raceAbort(wait, signal)
    if (value === null) return 'Stopped.'
    const result = parseAction(value)
    if (!result.ok && result.reason !== '') return result.reason
    const line = result.ok ? "It's there." : "Didn't appear in time."
    this.emit()
    return `${line}\n\n${await this.snapshot()}`
  }

  async screenshot(): Promise<string | null> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) return null
    try {
      const image = await tab.view.webContents.capturePage()
      if (image.isEmpty()) return null
      const path = join(this.screenshotsDir, `shot-${Date.now()}-${++this.shotSeq}.png`)
      writeFileSync(path, image.toPNG())
      return path
    } catch {
      return null
    }
  }

  async upload(index: number, path: string): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    let info: { name: string; type: string; base64: string; size: number }
    try {
      const stat = statSync(path)
      if (!stat.isFile()) return 'That path is not a file.'
      if (stat.size > MAX_UPLOAD_BYTES) return 'That file is too large for an automated upload (4 MB at most).'
      info = {
        name: basename(path),
        type: guessType(path),
        base64: readFileSync(path).toString('base64'),
        size: stat.size,
      }
    } catch {
      return `No such file: ${path}`
    }

    const result = parseAction(await this.run(tab, uploadScript(index, info)))
    if (!result.ok) return result.reason
    await this.settle(600)
    this.emit()
    return `Uploaded ${info.name} (${Math.max(1, Math.round(info.size / 1024))} KB). Read the page to confirm it was accepted.\n\n${await this.snapshot()}`
  }

  setAgentDriving(on: boolean, reason = ''): void {
    this.agentDriving = on
    this.handoffReason = on ? '' : reason
    for (const tab of this.tabs) void this.refreshInputGuard(tab)
    this.emit()
  }

  // ---- tabs and the window ----------------------------------------------------------------

  private activeTab(): Tab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? this.tabs[0] ?? null
  }

  private createTab(initialUrl?: string): Tab | null {
    if (this.tabs.length >= this.maxTabs) return null
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    view.setBackgroundColor('#ffffff')

    const tab: Tab = { id: `tab-${++this.tabSeq}`, view }
    this.tabs.push(tab)
    this.activeId = tab.id
    this.configureSession(view.webContents.session)
    this.wireTab(tab)

    if (this.window !== null) {
      try {
        this.window.contentView.addChildView(view)
      } catch {
        // The window may be closing; the view still loads and can be attached later.
      }
    }
    this.layout()

    if (initialUrl !== undefined) {
      void view.webContents.loadURL(initialUrl).catch(() => undefined)
    }
    void this.refreshInputGuard(tab)
    this.emit()
    return tab
  }

  private wireTab(tab: Tab): void {
    const wc = tab.view.webContents

    const guard = (event: Electron.Event, url: string): void => {
      const policy = checkBrowserUrl(url, { personTyped: !this.agentDriving })
      if (policy.ok) return
      event.preventDefault()
      this.blockedReason = policy.reason
      this.emit()
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)

    wc.setWindowOpenHandler(({ url }) => {
      const policy = checkBrowserUrl(url, { personTyped: !this.agentDriving })
      if (!policy.ok) {
        this.blockedReason = policy.reason
        this.emit()
        return { action: 'deny' }
      }
      if (this.tabs.length >= this.maxTabs) {
        this.blockedReason = 'There are already five browser tabs open.'
        this.emit()
        return { action: 'deny' }
      }
      this.createTab(policy.url)
      return { action: 'deny' }
    })

    wc.on('before-input-event', (event) => {
      // A key the agent sends itself must still reach the page.
      if (this.agentDriving && !this.injectingInput) event.preventDefault()
    })

    wc.on('did-navigate', () => {
      // Inserted CSS belongs to the old document; ask for it again on the new one.
      this.inputCss.delete(tab.id)
      void this.refreshInputGuard(tab)
      this.emit()
    })
    wc.on('did-navigate-in-page', () => this.emit())
    wc.on('page-title-updated', () => this.emit())
    wc.on('did-finish-load', () => {
      void this.refreshInputGuard(tab)
      this.emit()
    })
    wc.on('render-process-gone', () => this.emit())
    wc.on('destroyed', () => this.emit())
  }

  private configureSession(session: Session): void {
    if (this.sessionReady) return
    this.sessionReady = true

    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)

    const onDownload = (_event: Electron.Event, item: DownloadItem): void => {
      const path = join(this.downloadsDir, `${Date.now()}-${safeFilename(item.getFilename())}`)
      item.setSavePath(path)
      item.once('done', (_doneEvent, state) => {
        if (state === 'completed') {
          this.downloads.push(path)
          this.emit()
        }
      })
    }
    session.on('will-download', onDownload)
    this.sessionCleanups.push(() => session.removeListener('will-download', onDownload))
  }

  private layout(): void {
    const visible = this.bounds.visible && this.bounds.width > 0 && this.bounds.height > 0
    for (const tab of this.tabs) {
      if (tab.view.webContents.isDestroyed()) continue
      try {
        tab.view.setBounds({
          x: this.bounds.x,
          y: this.bounds.y,
          width: this.bounds.width,
          height: this.bounds.height,
        })
        tab.view.setVisible(visible && tab.id === this.activeId)
      } catch {
        // Bounds cannot be set on a view whose window has gone.
      }
    }
  }

  private async refreshInputGuard(tab: Tab): Promise<void> {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    const existing = this.inputCss.get(tab.id)
    try {
      if (this.agentDriving) {
        if (existing === undefined) {
          const key = await wc.insertCSS('html,body{pointer-events:none !important}')
          this.inputCss.set(tab.id, key)
        }
      } else if (existing !== undefined) {
        this.inputCss.delete(tab.id)
        await wc.removeInsertedCSS(existing)
      }
    } catch {
      // A page that navigated while the CSS was being applied does not need the old key.
    }
  }

  // ---- page helpers -----------------------------------------------------------------------

  private async run(tab: Tab, code: string): Promise<unknown> {
    return tab.view.webContents.executeJavaScriptInIsolatedWorld(PAGE_WORLD_ID, [{ code }])
  }

  private pressKey(tab: Tab, key: string): void {
    const wc = tab.view.webContents
    this.injectingInput = true
    try {
      wc.sendInputEvent({ type: 'keyDown', keyCode: key })
      if (key.length === 1) wc.sendInputEvent({ type: 'char', keyCode: key })
      wc.sendInputEvent({ type: 'keyUp', keyCode: key })
    } finally {
      this.injectingInput = false
    }
  }

  private async waitForLoad(tab: Tab, timeoutMs = 5_000): Promise<void> {
    const wc = tab.view.webContents
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        wc.removeListener('did-stop-loading', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      wc.once('did-stop-loading', finish)
      if (!wc.isLoading()) finish()
    })
  }

  private async settle(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  private emit(): void {
    try {
      this.onState(this.state())
    } catch {
      // A renderer that is closing must not break the browser.
    }
  }

  /** Used by the Electron smoke test: load a data: page and prove the outline helper sees it. */
  async smokeOutline(html: string): Promise<boolean> {
    this.setBounds({ x: 0, y: 0, width: 480, height: 360, visible: true })
    const tab = this.activeTab() ?? this.createTab()
    if (tab === null) return false
    try {
      await tab.view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      await this.settle(200)
      const outline = parseOutline(await this.run(tab, outlineScript()))
      return (
        outline.headings.includes('Smoke') &&
        outline.elements.some((element) => element.label === 'Save')
      )
    } catch (error) {
      console.error('BROWSER SMOKE error:', error instanceof Error ? error.message : String(error))
      return false
    }
  }
}

function isRealPage(view: WebContentsView): boolean {
  const url = safeUrl(view)
  return url !== '' && url !== 'about:blank'
}

function safeUrl(view: WebContentsView): string {
  try {
    return view.webContents.getURL()
  } catch {
    return ''
  }
}

function safeTitle(view: WebContentsView): string {
  try {
    return view.webContents.getTitle()
  } catch {
    return ''
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || 'that page'
  } catch {
    return 'that page'
  }
}

function safeFilename(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, '')
  return clean === '' ? 'download' : clean.slice(0, 120)
}

function guessType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.doc')) return 'application/msword'
  if (lower.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  return 'application/octet-stream'
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.resolve(null)
  return new Promise<T | null>((resolve) => {
    let settled = false
    const finish = (value: T | null): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => finish(null)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(value),
      () => finish(null),
    )
  })
}

export type { BrowserBounds, BrowserState }
