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
import { Script } from 'node:vm'

import { shell, WebContentsView } from 'electron'
import type { BrowserWindow, DownloadItem, Session } from 'electron'

import type { BrowserBounds, BrowserState, BrowserTab } from '@agent/core'

import { Cdp, KEY_NAMES } from './cdp'
import {
  chromeVersionOf,
  emulationCommands,
  fitView,
  presetView,
  resolveView,
  userAgentFor,
  viewLabel,
  type EngineInfo,
  type FitResult,
  type ViewSpec,
} from './emulation'
import {
  assessPage,
  diagnosis,
  identityMayHelp,
  openAdaptive,
  otherView,
  REFUSAL_LABEL,
  siteOf,
  SiteStore,
  type SitePort,
} from './sites'
import {
  evalWrapper,
  fieldValueScript,
  formatSnapshot,
  looksLikeExpression,
  pageTextScript,
  parseResolved,
  parseSnapshot,
  resolveScript,
  selectFieldScript,
  selectOptionScript,
  snapshotScript,
  type Resolved,
} from './snapshot'
import type { ActRequest, BrowserDriver, BrowserProDriver, FixRequest, ViewRequest } from './types'
import { pickTab } from './tab-pick'
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
  /** The session partition: General's original one, or a profile's own (its cookies and sign-ins). */
  partition: string
  view: WebContentsView
  cdp: Cdp
  /** The emulation is set up (the debugger can only attach once a document exists). */
  ready: boolean
  /** The view the tab is emulating now, and the scale it is drawn at. */
  applied: ViewSpec | null
  scale: number
  status: number | null
  loadError: string | null
  /** insertCSS keys of the site's own fixes in the current document. */
  siteCss: string[]
}

export interface AgentBrowserOptions {
  window: BrowserWindow
  partition?: string
  maxTabs?: number
  onState?: (state: BrowserState) => void
  openExternal?: (url: string) => Promise<void>
  tempRoot?: string
  /** Where what the browser learns about sites is kept (a JSON file under userData). Null keeps it in memory. */
  sitesFile?: string | null
}

export class AgentBrowser implements BrowserDriver, BrowserProDriver {
  private window: BrowserWindow | null
  private readonly partition: string
  /** The partition the agent works in now (profiles.ts partitionFor). Tabs of others stay open, untouched. */
  private current: string
  private readonly maxTabs: number
  private readonly onState: (state: BrowserState) => void
  private readonly openExternal: (url: string) => Promise<void>
  private readonly runDir: string
  private readonly downloadsDir: string
  private readonly screenshotsDir: string
  private readonly tabs: Tab[] = []
  /** The pointer guard per tab: its insertCSS key once inserted, and a token so a stale insert removes itself. */
  private readonly inputCss = new Map<string, { token: number; key: string | null }>()
  /** How many agent actions are under way per tab with the guard lifted. */
  private readonly lifted = new Map<string, number>()
  private guardSeq = 0
  private readonly downloads: string[] = []
  private readonly sessionCleanups: Array<() => void> = []

  private activeId: string | null = null
  private bounds: BrowserBounds = { ...EMPTY_BOUNDS }
  private agentDriving = true
  private handoffReason = ''
  private blockedReason = ''
  /** Partitions whose session is set up: one header listener and one download handler per session. */
  private readonly sessionsReady = new Set<string>()
  private injectingInput = false
  private tabSeq = 0
  private shotSeq = 0
  private destroyed = false
  private readonly sites: SiteStore
  private readonly engine: EngineInfo
  /** What the agent (or the person) chose for the page in front of it. */
  private currentView: ViewSpec
  private lastFit: FitResult = { bounds: { x: 0, y: 0, width: 0, height: 0 }, scale: 1 }
  /** browser_open applies the site's view itself; navigation listeners leave it alone meanwhile. */
  private opening = false
  private expanded = false

  constructor(options: AgentBrowserOptions) {
    this.window = options.window
    this.partition = options.partition ?? PARTITION
    this.current = this.partition
    this.maxTabs = Math.max(1, options.maxTabs ?? MAX_TABS)
    this.onState = options.onState ?? (() => undefined)
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))

    const root = options.tempRoot ?? tmpdir()
    this.runDir = mkdtempSync(join(root, 'agent-browser-'))
    this.downloadsDir = join(this.runDir, 'downloads')
    this.screenshotsDir = join(this.runDir, 'screenshots')
    mkdirSync(this.downloadsDir, { recursive: true })
    mkdirSync(this.screenshotsDir, { recursive: true })

    this.sites = new SiteStore(options.sitesFile ?? null)
    this.currentView = this.sites.defaultView()
    let engineUa = ''
    try {
      engineUa = options.window.webContents.getUserAgent()
    } catch {
      engineUa = ''
    }
    this.engine = { chromeVersion: chromeVersionOf(engineUa), platform: process.platform }

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
    // The panel shows the tab in front, whichever profile it belongs to.
    const active = this.shownTab()
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
      expanded: this.expanded,
      view: {
        mode: this.currentView.mode,
        label: viewLabel(this.currentView),
        width: this.currentView.width,
        height: this.currentView.height,
        scale: Math.round(this.lastFit.scale * 1000) / 1000,
      },
    }
  }

  /** While the person drives, the agent's own input waits: one pair of hands at a time. */
  private pausedLine(): string {
    return 'The person has the browser right now, so I am paused. Wait for them to hand it back (they press Done, carry on), or ask them in the chat.'
  }

  /** The page over the whole app window (the person helping out), or back in the chat panel. */
  setExpanded(on: boolean): void {
    if (this.expanded === on) return
    this.expanded = on
    this.emit()
  }

  /** The panel's own switch: the person picks a device; it is remembered for the site like the agent's choice. */
  async setViewMode(mode: ViewSpec['mode']): Promise<void> {
    await this.view({ mode })
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
    const tab = this.shownTab()
    if (tab === null) return
    tab.view.webContents.reload()
    this.emit()
  }

  selectTab(id: string): void {
    const picked = this.tabs.find((tab) => tab.id === id)
    if (picked === undefined) return
    this.activeId = id
    // The person picked a tab: the agent's next step works in that tab's sign-ins too.
    this.current = picked.partition
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
  async evaluateRaw(code: string, timeoutMs = 30_000): Promise<unknown> {
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

  async open(raw: string, asked: ViewRequest | null = null): Promise<string> {
    if (!this.agentDriving) return this.pausedLine()
    return this.openChecked(checkBrowserUrl(raw), asked)
  }

  /**
   * Test hook for the real-Electron proof: opens a page the person could open (a local test page)
   * through the same adaptive path the agent uses. Only index.ts calls it, only when a probe is asked for.
   */
  async probeOpen(raw: string): Promise<string> {
    return this.openChecked(checkBrowserUrl(raw, { personTyped: true }), null)
  }

  private async openChecked(policy: ReturnType<typeof checkBrowserUrl>, asked: ViewRequest | null): Promise<string> {
    if (!policy.ok) return policy.reason
    const tab = this.activeTab() ?? this.createTab()
    if (tab === null) return 'I could not open another browser tab.'

    this.blockedReason = ''
    const before = safeUrl(tab.view)
    await this.prepare(tab)
    const askedView = asked === null ? null : resolveView(this.sites.viewFor(policy.url), asked)
    const port: SitePort = {
      currentView: () => this.currentView,
      applyView: async (view) => {
        this.currentView = { ...view }
        await this.applyEmulation(tab)
      },
      load: async (url) => this.loadAndRead(tab, url),
    }
    this.opening = true
    let opened
    try {
      opened = await openAdaptive(port, this.sites, policy.url, askedView)
    } finally {
      this.opening = false
    }
    if (safeUrl(tab.view) === before && before === '' && opened.verdict.refusal === 'load_error') {
      return `I could not open ${hostOf(policy.url)}. ${opened.verdict.evidence}`
    }
    this.layout()
    this.emit()
    return this.snapshotText(tab, { notes: opened.notes })
  }

  async snapshot(): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    return this.snapshotText(tab, {})
  }

  async snapshotPro(options: { filter?: string; deep?: boolean }): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    return this.snapshotText(tab, options)
  }

  private async snapshotText(tab: Tab, options: { filter?: string; deep?: boolean; notes?: string }): Promise<string> {
    let raw: unknown
    try {
      raw = await this.run(tab, snapshotScript({ ...(options.filter === undefined ? {} : { filter: options.filter }), ...(options.deep === undefined ? {} : { deep: options.deep }) }))
    } catch {
      // A page mid-navigation has no document to read yet; give it a moment once.
      await this.settle(400)
      raw = await this.run(tab, snapshotScript({ ...(options.filter === undefined ? {} : { filter: options.filter }), ...(options.deep === undefined ? {} : { deep: options.deep }) }))
    }
    const result = parseSnapshot(raw)
    if (this.blockedReason !== '') {
      result.note = result.note === '' ? this.blockedReason : `${result.note} ${this.blockedReason}`
      this.blockedReason = ''
    }
    return formatSnapshot(result, {
      view: `${viewLabel(this.currentView)}${this.currentView.mode === 'fit' || !this.bounds.visible ? '' : `, shown at ${Math.round(this.lastFit.scale * 100)}% in the panel`}`,
      downloads: this.downloads.slice(-5),
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      ...(options.notes === undefined ? {} : { notes: options.notes }),
    })
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
    return this.act({ action: 'click', index })
  }

  async type(index: number, text: string, submit: boolean): Promise<string> {
    return this.act({ action: 'type', index, text, submit })
  }

  async press(key: string): Promise<string> {
    return this.act({ action: 'press', key })
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

  /** A PNG of the page at the size it is laid out at (1440x900 for desktop), not the small panel copy. */
  async screenshot(): Promise<string | null> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) return null
    let png: Buffer | null = null
    try {
      const image = await Promise.race([
        tab.view.webContents.capturePage(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
      ])
      if (image !== null && !image.isEmpty()) png = image.toPNG()
    } catch {
      png = null
    }
    if (png === null && tab.ready) {
      // A hidden view may not paint; the debugger can still render the page.
      try {
        const shot = objectOf(await tab.cdp.send('Page.captureScreenshot', { format: 'png' }))
        if (typeof shot['data'] === 'string') png = Buffer.from(shot['data'], 'base64')
      } catch {
        png = null
      }
    }
    if (png === null) return null
    try {
      const path = join(this.screenshotsDir, `shot-${Date.now()}-${++this.shotSeq}.png`)
      writeFileSync(path, png)
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

  // ---- the view: device, size, zoom ---------------------------------------------------------

  async view(request: ViewRequest): Promise<string> {
    const tab = this.activeTab()
    const url = tab === null ? '' : safeUrl(tab.view)
    const site = siteOf(url)
    let next: ViewSpec
    if (request.reset === true) {
      next = request.asDefault === true ? presetView('desktop') : this.sites.defaultView()
      if (site !== null) {
        this.sites.update(url, (profile) => {
          delete profile.view
          delete profile.pinned
          delete profile.outcome
        })
      }
    } else {
      const { reset: _reset, asDefault: _asDefault, remember: _remember, ...change } = request
      next = resolveView(this.currentView, change)
    }
    const changedIdentity = next.mode !== this.currentView.mode || next.userAgent !== this.currentView.userAgent
    this.currentView = next
    if (request.asDefault === true) this.sites.setDefaultView(next)
    if (request.reset !== true && request.remember !== false && site !== null) {
      this.sites.update(url, (profile) => {
        profile.view = { ...next }
        profile.pinned = true
        profile.outcome = 'works'
        profile.reason = 'chosen by hand'
      })
    }
    for (const each of this.tabs) await this.applyEmulation(each)
    this.layout()
    // A new user agent only reaches the site on the next request; reload so the site sees the device it is meant to.
    if (tab !== null && isRealPage(tab.view) && changedIdentity) {
      tab.view.webContents.reload()
      await this.waitForLoad(tab, 10_000)
      await this.settle(300)
    } else {
      await this.settle(150)
    }
    this.emit()
    const lines = [`View: ${viewLabel(next)}${next.mode === 'fit' ? '' : `, drawn at ${Math.round(this.lastFit.scale * 100)}% to fit the panel`}.`]
    if (request.asDefault === true) lines.push('This is now the default for sites I have not learned yet.')
    if (request.reset !== true && request.remember !== false && site !== null) lines.push(`Remembered for ${site}.`)
    if (tab !== null && isRealPage(tab.view)) {
      try {
        const seen = await tab.view.webContents.executeJavaScript(
          'JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent, touch: navigator.maxTouchPoints })',
        )
        lines.push(`The page sees: ${String(seen)}`)
      } catch {
        // The page is between documents; the snapshot below shows it once it lands.
      }
      lines.push('', await this.snapshotText(tab, {}))
    }
    return lines.join('\n')
  }

  // ---- fixing a site on the fly ---------------------------------------------------------------

  async fix(request: FixRequest): Promise<string> {
    const tab = this.activeTab()
    const url = tab === null ? '' : safeUrl(tab.view)
    const site = siteOf(url)
    if (request.action === 'list') {
      const all = this.sites.list().slice(0, 30)
      const head = `Default view for new sites: ${viewLabel(this.sites.defaultView())}.`
      if (all.length === 0) return `${head}\nNo sites learned yet.`
      return [
        head,
        ...all.map(({ site: name, profile }) => {
          const parts: string[] = []
          if (profile.view !== undefined) parts.push(`${profile.outcome === 'refused' ? 'refused as' : 'works as'} ${viewLabel(profile.view)}${profile.pinned === true ? ' (chosen)' : ''}`)
          if (profile.reason !== undefined && profile.reason !== '') parts.push(profile.reason)
          if (profile.css !== undefined && profile.css.length > 0) parts.push(`${profile.css.length} CSS fix(es)`)
          if (profile.js !== undefined && profile.js.length > 0) parts.push(`${profile.js.length} script fix(es)`)
          if (profile.headers !== undefined && Object.keys(profile.headers).length > 0) parts.push(`headers: ${Object.keys(profile.headers).join(', ')}`)
          return `- ${name}: ${parts.join('; ')}`
        }),
      ].join('\n')
    }
    if (!this.agentDriving) return this.pausedLine()
    if (tab === null || !isRealPage(tab.view) || site === null) {
      return 'Open the site first (browser_open), then fix it.'
    }
    const wc = tab.view.webContents
    const persist = request.persist !== false
    switch (request.action) {
      case 'css': {
        const css = (request.css ?? '').trim()
        if (css === '') return 'Pass the CSS to apply, for example .cookie-banner{display:none!important}.'
        await this.liftGuard(tab, async () => {
          tab.siteCss.push(await wc.insertCSS(css, { cssOrigin: 'user' }))
        })
        if (persist) this.sites.addCss(url, css)
        await this.settle(150)
        return `Applied the CSS${persist ? ` and kept it for every visit to ${site}` : ' to this page only'}.\n\n${await this.snapshotText(tab, {})}`
      }
      case 'js': {
        const js = (request.js ?? '').trim()
        if (js === '') return 'Pass the script to run on the site.'
        const result = await this.runMain(tab, js, 20)
        if (persist) this.sites.addJs(url, js)
        return `${result}\n${persist ? `Kept: it runs on every page of ${site} once it loads.` : 'Ran once.'}`
      }
      case 'clear_data': {
        const removed = await this.clearSiteData(tab, url)
        wc.reload()
        await this.waitForLoad(tab, 10_000)
        await this.settle(300)
        return `Cleared ${site}'s cookies (${removed}), storage, caches and service workers, then reloaded.\n\n${await this.snapshotText(tab, {})}`
      }
      case 'headers': {
        const headers = request.headers ?? {}
        const clean: Record<string, string> = {}
        for (const [name, value] of Object.entries(headers)) {
          const key = name.trim()
          if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) return `"${name}" is not a header name.`
          if (/^(cookie|host|content-length)$/i.test(key)) return `The ${key} header cannot be set this way.`
          clean[key] = String(value).slice(0, 2000)
        }
        if (Object.keys(clean).length === 0) return 'Pass the headers as name and value, an empty value removes one.'
        this.sites.setHeaders(url, clean)
        wc.reload()
        await this.waitForLoad(tab, 10_000)
        await this.settle(300)
        return `Every request to ${site} now carries: ${Object.keys(clean).map((key) => (clean[key] === '' ? `${key} (removed)` : key)).join(', ')}. Reloaded.\n\n${await this.snapshotText(tab, {})}`
      }
      case 'user_agent':
        return this.view({ userAgent: (request.userAgent ?? '').trim() })
      case 'retry': {
        const from = this.currentView
        const to = otherView(from)
        this.currentView = to
        await this.applyEmulation(tab)
        this.layout()
        const page = await this.loadAndRead(tab, url)
        const verdict = assessPage(page.status, page.error, page.title, page.text)
        if (verdict.refusal === 'none') {
          this.sites.record(url, to, 'works', `retried by the agent after ${viewLabel(from)}`)
          this.emit()
          return `Opened again as ${viewLabel(to)} and it loaded. Remembered for ${site}.\n\n${await this.snapshotText(tab, {})}`
        }
        this.emit()
        return `${diagnosis(verdict, [viewLabel(from), viewLabel(to)])}\n${await this.snapshotText(tab, {})}`
      }
      case 'forget': {
        for (const key of tab.siteCss.splice(0)) await wc.removeInsertedCSS(key).catch(() => undefined)
        const had = this.sites.forget(url)
        return had ? `Forgot everything learned about ${site}: its view, fixes and headers.` : `Nothing was learned about ${site} yet.`
      }
    }
    return 'Use css, js, clear_data, headers, user_agent, retry, forget or list.'
  }

  // ---- acting with trusted input --------------------------------------------------------------

  async act(request: ActRequest): Promise<string> {
    if (!this.agentDriving) return this.pausedLine()
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    const wc = tab.view.webContents
    await this.prepare(tab)
    const scale = this.drawScale(tab)
    const action = request.action

    if (action === 'press') {
      const key = (request.key ?? '').trim()
      if (key === '') return `Pass the key, for example Enter, Tab, Escape, ArrowDown or ctrl+a. Known: ${KEY_NAMES.join(', ')}.`
      const ok = await this.trusted(tab, async () => tab.cdp.press(key))
      if (ok !== true) {
        if (!['Enter', 'Tab', 'Escape'].includes(key)) return `I do not know the key "${key}".`
        this.pressKey(tab, key)
      }
      await this.settle(350)
      this.emit()
      return `Pressed ${key}.\n\n${await this.snapshotText(tab, {})}`
    }

    if (action === 'scroll' && request.at === undefined && request.name === undefined && request.index === undefined) {
      const dy = Math.round(request.dy ?? 600)
      const size = this.viewportSize()
      const centre = { x: size.width / 2, y: size.height / 2 }
      const ok = await this.trusted(tab, async () => {
        await tab.cdp.wheel(centre, scale, dy)
        return true
      })
      if (ok !== true) await this.run(tab, `(() => { window.scrollBy(0, ${dy}); return { ok: true }; })()`)
      await this.settle(300)
      return this.snapshotText(tab, {})
    }

    // A point the agent read off a screenshot: canvases, maps, cross-origin frames.
    if (request.at !== undefined) {
      const at = request.at
      const label = `the point ${Math.round(at.x)},${Math.round(at.y)}`
      const done = await this.trusted(tab, async () => {
        if (action === 'drag') {
          if (request.to === undefined) return 'Pass to:{x,y} for a drag.'
          await tab.cdp.drag(at, request.to, this.shotScale(tab))
          return `Dragged from ${label} to ${Math.round(request.to.x)},${Math.round(request.to.y)}.`
        }
        if (action === 'hover') {
          await tab.cdp.hover(at, this.shotScale(tab))
          return `Moved the mouse to ${label}.`
        }
        if (action === 'hold') {
          await tab.cdp.hold(at, this.shotScale(tab), clampMs(request.ms))
          return `Held ${label} for ${clampMs(request.ms)} ms.`
        }
        if (action === 'scroll') {
          await tab.cdp.wheel(at, this.shotScale(tab), Math.round(request.dy ?? 600))
          return `Scrolled at ${label}.`
        }
        await tab.cdp.click(at, this.shotScale(tab), {
          clickCount: action === 'double_click' ? 2 : 1,
          button: action === 'right_click' ? 'right' : 'left',
        })
        if (action === 'type' && request.text !== undefined) {
          await tab.cdp.insertText(request.text)
          if (request.submit === true) await tab.cdp.press('Enter')
          return `Clicked ${label} and typed.`
        }
        return `Clicked ${label}.`
      })
      if (typeof done !== 'string') return 'The page did not accept input at that point.'
      await this.settle(450)
      this.emit()
      return `${done}\n\n${await this.snapshotText(tab, {})}`
    }

    if (request.index === undefined && (request.name ?? '').trim() === '') {
      return 'Say which element: its name (best, it survives re-renders) or its [number] from the snapshot, or at:{x,y}.'
    }

    try {
      return (
      (await this.liftGuard(tab, async () => {
        const resolved = parseResolved(
          await this.run(
            tab,
            resolveScript({
              ...(request.index === undefined ? {} : { index: request.index }),
              ...(request.name === undefined ? {} : { name: request.name }),
              ...(request.role === undefined ? {} : { role: request.role }),
              ...(request.nth === undefined ? {} : { nth: request.nth }),
            }),
          ),
        )
        if (!resolved.ok) {
          const near = resolved.candidates.length > 0 ? `\nOn the page: ${resolved.candidates.join('; ')}` : ''
          return `${resolved.reason}${near}`
        }
        return this.actOn(tab, resolved, request, scale)
      })) ?? 'The page went away while I was acting on it.'
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `The page did not take that: ${message}. Take a new snapshot; if it keeps failing, try at:{x,y} from a screenshot.`
    }
  }

  private async actOn(tab: Tab, target: Resolved, request: ActRequest, scale: number): Promise<string> {
    const wc = tab.view.webContents
    const point = { x: target.x * this.zoomOf(tab), y: target.y * this.zoomOf(tab) }
    const covered = target.covered === '' ? '' : `\nWARNING: ${target.covered} is on top of it, so the click may have landed there. If nothing changed, hide the overlay with browser_fix css or close it first.`
    const action = request.action
    const cdpOk = tab.cdp.ensure()

    if (action === 'select') {
      const option = request.text ?? ''
      if (option.trim() === '') return 'Pass the option to pick in text.'
      const picked = objectOf(await this.run(tab, selectOptionScript(option)))
      if (picked['ok'] !== true) {
        // Not a native list: open it with a real click, then the option is an element to click by name.
        if (target.tag !== 'select' && cdpOk) {
          await tab.cdp.click(point, scale)
          await this.settle(400)
          return `Opened ${target.label}. Now click the option by name.\n\n${await this.snapshotText(tab, { filter: option })}`
        }
        return String(picked['reason'] ?? 'Could not pick that option.')
      }
      await this.settle(300)
      this.emit()
      return `Picked "${String(picked['value'] ?? option)}" in ${target.label}.\n\n${await this.snapshotText(tab, {})}`
    }

    if (action === 'check' || action === 'uncheck') {
      const want = action === 'check'
      if (target.checked === want) return `${target.label} is already ${want ? 'checked' : 'unchecked'}.`
    }

    if (action === 'focus') {
      await this.run(tab, selectFieldScript())
      return `Focused ${target.label}.`
    }

    if (action === 'hover') {
      if (cdpOk) await tab.cdp.hover(point, scale)
      await this.settle(300)
      return `Hovering over ${target.label}.${covered}\n\n${await this.snapshotText(tab, {})}`
    }

    if (action === 'hold') {
      if (!cdpOk) return 'This page does not accept a press-and-hold right now.'
      await tab.cdp.hold(point, scale, clampMs(request.ms))
      await this.settle(400)
      return `Held ${target.label} for ${clampMs(request.ms)} ms.${covered}\n\n${await this.snapshotText(tab, {})}`
    }

    if (action === 'drag') {
      if (!cdpOk || request.to === undefined) return 'Pass to:{x,y} (screenshot pixels) for where to drop it.'
      await tab.cdp.drag(point, { x: request.to.x / Math.max(0.01, this.shotScale(tab) / scale), y: request.to.y / Math.max(0.01, this.shotScale(tab) / scale) }, scale)
      await this.settle(400)
      return `Dragged ${target.label}.\n\n${await this.snapshotText(tab, {})}`
    }

    if (action === 'scroll') {
      if (cdpOk) await tab.cdp.wheel(point, scale, Math.round(request.dy ?? 600))
      await this.settle(300)
      return this.snapshotText(tab, {})
    }

    if (action === 'type') {
      const text = request.text ?? ''
      if (target.tag === 'select') return this.actOn(tab, target, { ...request, action: 'select' }, scale)
      if (cdpOk) {
        await this.trustedInput(async () => tab.cdp.click(point, scale))
        await this.settle(80)
        const focused = objectOf(await this.run(tab, selectFieldScript()))
        if (focused['ok'] !== true && !target.editable) return `${target.label} is not a text field.`
        await this.trustedInput(async () => {
          if (text === '') await tab.cdp.press('Delete')
          else await tab.cdp.insertText(text)
        })
      } else {
        const index = request.index
        if (index === undefined) return 'Typing by name needs the page debugger, which is busy. Use the element number.'
        const legacy = parseAction(await this.run(tab, typeScript(index, text)))
        if (!legacy.ok) return legacy.reason
      }
      const value = objectOf(await this.run(tab, fieldValueScript()))
      const readBack = typeof value['value'] === 'string' ? value['value'] : ''
      const mismatch = readBack !== text && !readBack.startsWith('(hidden') ? ` It now reads "${readBack.slice(0, 120)}", not exactly what was typed: check it.` : ` It now reads "${readBack.slice(0, 120)}".`
      if (request.submit === true) {
        await this.trustedInput(async () => {
          if (cdpOk) await tab.cdp.press('Enter')
          else this.pressKey(tab, 'Enter')
        })
        await this.settle(600)
        this.emit()
        return `Typed into ${target.label} and pressed Enter.${mismatch}\n\n${await this.snapshotText(tab, {})}`
      }
      await this.settle(150)
      return `Typed into ${target.label}.${mismatch}`
    }

    // click, double_click, right_click, check, uncheck
    const before = safeUrl(tab.view)
    if (cdpOk) {
      await this.trustedInput(async () =>
        tab.cdp.click(point, scale, {
          clickCount: action === 'double_click' ? 2 : 1,
          button: action === 'right_click' ? 'right' : 'left',
        }),
      )
    } else if (request.index !== undefined) {
      const legacy = parseAction(await this.run(tab, clickScript(request.index)))
      if (!legacy.ok) return legacy.reason
    } else {
      return 'The page debugger is busy, so I cannot click by name. Use the element number.'
    }
    await this.settle(450)
    if (wc.isLoading()) await this.waitForLoad(tab, 8_000)
    this.emit()
    const moved = safeUrl(tab.view) !== before ? ` The page moved to ${safeUrl(tab.view)}.` : ''
    return `Clicked ${target.label}.${moved}${covered}\n\n${await this.snapshotText(tab, {})}`
  }

  // ---- running the agent's own script in the page --------------------------------------------

  async evaluate(code: string, seconds: number, signal?: AbortSignal): Promise<string> {
    if (!this.agentDriving) return this.pausedLine()
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.view)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    if (signal?.aborted === true) return 'Stopped.'
    const result = await raceAbort(this.runMain(tab, code, seconds), signal)
    if (result === null) return 'Stopped.'
    this.emit()
    return result
  }

  private async runMain(tab: Tab, code: string, seconds: number): Promise<string> {
    const expression = looksLikeExpression(code, compiles)
    const wrapped = evalWrapper(code, expression)
    const limit = Math.max(1, Math.min(120, seconds)) * 1000
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        this.liftGuard(tab, async () => tab.view.webContents.executeJavaScript(wrapped, true) as Promise<unknown>),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), limit)
        }),
      ])
      if (value === 'timeout') {
        return `Still running after ${Math.round(limit / 1000)} s; it carries on in the page. For long flows start the work without awaiting it, log() progress, and poll window.__agentLog with another browser_eval.`
      }
      const raw = objectOf(value)
      const log = Array.isArray(raw['log']) ? (raw['log'] as unknown[]).map((line) => String(line)) : []
      const lines: string[] = []
      if (raw['ok'] === true) {
        const shown = raw['value'] === undefined ? '(no value returned)' : truncate(JSON.stringify(raw['value'], null, 1), 8000)
        lines.push(`Result: ${shown}`)
      } else {
        lines.push(`The script failed: ${String(raw['error'] ?? 'unknown error')}`)
      }
      if (log.length > 0) lines.push('', 'Log:', ...log.slice(-80))
      return lines.join('\n')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `The script could not run: ${message}`
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  // ---- emulation plumbing ---------------------------------------------------------------------

  /** Attaches the debugger and applies the current view. The first document must exist first. */
  private async prepare(tab: Tab): Promise<void> {
    if (tab.ready) return
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    if (safeUrl(tab.view) === '') {
      // Attaching the debugger to a view that never loaded a document crashes Electron 44.
      await wc.loadURL('about:blank').catch(() => undefined)
    }
    tab.ready = tab.cdp.ensure()
    await this.applyEmulation(tab)
  }

  private async applyEmulation(tab: Tab): Promise<void> {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    const view = this.currentView
    const fit = fitView(this.slotRect(), view)
    if (tab.id === this.activeId || this.tabs.length === 1) this.lastFit = fit
    tab.scale = fit.scale
    if (tab.ready) {
      for (const command of emulationCommands(view, this.engine, fit)) {
        try {
          await tab.cdp.send(command.method, command.params)
        } catch {
          // An emulation step a page refuses (touch on a crashed renderer) is not worth failing the view for.
        }
      }
    } else {
      try {
        wc.setUserAgent(userAgentFor(view, this.engine))
      } catch {
        // Already gone.
      }
    }
    try {
      wc.setZoomFactor(view.zoom)
    } catch {
      // Already gone.
    }
    tab.cdp.touch = view.touch && tab.ready
    tab.applied = { ...view }
    tab.view.setBackgroundColor(view.mode === 'fit' ? '#ffffff' : '#00000000')
  }

  /** Only the scale changed (the panel was resized): no new user agent, no reload. */
  private async rescale(tab: Tab, fit: FitResult): Promise<void> {
    if (!tab.ready || this.currentView.mode === 'fit') return
    if (Math.abs(tab.scale - fit.scale) < 0.0005) return
    tab.scale = fit.scale
    const command = emulationCommands(this.currentView, this.engine, fit).find((c) => c.method === 'Emulation.setDeviceMetricsOverride')
    if (command === undefined) return
    await tab.cdp.send(command.method, command.params).catch(() => undefined)
  }

  private slotRect(): { x: number; y: number; width: number; height: number } {
    return { x: this.bounds.x, y: this.bounds.y, width: this.bounds.width, height: this.bounds.height }
  }

  /** Page CSS px to view px for CDP input. */
  private drawScale(tab: Tab): number {
    return this.currentView.mode === 'fit' ? 1 : tab.scale
  }

  /** Screenshot px to view px. Screenshots are taken at the emulated size, so this is the draw scale. */
  private shotScale(tab: Tab): number {
    return this.drawScale(tab)
  }

  private zoomOf(tab: Tab): number {
    try {
      return tab.view.webContents.getZoomFactor()
    } catch {
      return 1
    }
  }

  private viewportSize(): { width: number; height: number } {
    if (this.currentView.mode === 'fit') return { width: Math.max(1, this.bounds.width), height: Math.max(1, this.bounds.height) }
    return { width: this.currentView.width, height: this.currentView.height }
  }

  /** Loads a URL and reports what came back, for the site health check. */
  private async loadAndRead(tab: Tab, url: string): Promise<{ status: number | null; error: string | null; title: string; text: string }> {
    const wc = tab.view.webContents
    tab.status = null
    tab.loadError = null
    try {
      await wc.loadURL(url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (tab.loadError === null && !/ERR_ABORTED/.test(message)) tab.loadError = message
    }
    await this.settle(300)
    let page = await this.readText(tab)
    if (page.text.trim().length < 25 && tab.loadError === null) {
      // Single-page apps often paint their text a moment after load.
      await this.settle(1500)
      page = await this.readText(tab)
    }
    return { status: tab.status, error: tab.loadError, title: page.title, text: page.text }
  }

  private async readText(tab: Tab): Promise<{ title: string; text: string }> {
    try {
      const raw = objectOf(await this.run(tab, pageTextScript()))
      return { title: typeof raw['title'] === 'string' ? raw['title'] : '', text: typeof raw['text'] === 'string' ? raw['text'] : '' }
    } catch {
      return { title: safeTitle(tab.view), text: '' }
    }
  }

  private async applySiteFixes(tab: Tab): Promise<void> {
    const wc = tab.view.webContents
    const url = safeUrl(tab.view)
    const profile = this.sites.get(url)
    tab.siteCss = []
    if (profile === null) return
    for (const css of profile.css ?? []) {
      try {
        tab.siteCss.push(await wc.insertCSS(css, { cssOrigin: 'user' }))
      } catch {
        // The document changed again; the next dom-ready applies it.
      }
    }
    for (const js of profile.js ?? []) {
      await wc.executeJavaScript(`(async () => { try { ${js}\n } catch (e) { console.warn('site fix failed', e); } })()`, true).catch(() => undefined)
    }
  }

  private async clearSiteData(tab: Tab, url: string): Promise<number> {
    const session = tab.view.webContents.session
    const site = siteOf(url) ?? ''
    let removed = 0
    try {
      const origin = new URL(url).origin
      await session.clearStorageData({
        origin,
        storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem', 'shadercache'],
      })
    } catch {
      // Fall through to the cookie sweep.
    }
    try {
      const cookies = await session.cookies.get({})
      for (const cookie of cookies) {
        const domain = (cookie.domain ?? '').replace(/^\./, '')
        if (domain === '' || !(domain === site || domain.endsWith(`.${site}`) || site.endsWith(`.${domain}`))) continue
        const scheme = cookie.secure === true ? 'https' : 'http'
        await session.cookies.remove(`${scheme}://${domain}${cookie.path ?? '/'}`, cookie.name).catch(() => undefined)
        removed++
      }
    } catch {
      // Nothing else to remove.
    }
    return removed
  }

  /** The page ignores the person's pointer while the agent drives; lift that for the agent's own input. */
  private async liftGuard<T>(tab: Tab, action: () => Promise<T>): Promise<T | null> {
    this.lifted.set(tab.id, (this.lifted.get(tab.id) ?? 0) + 1)
    await this.refreshInputGuard(tab)
    try {
      return await action()
    } finally {
      const left = (this.lifted.get(tab.id) ?? 1) - 1
      if (left <= 0) this.lifted.delete(tab.id)
      else this.lifted.set(tab.id, left)
      void this.refreshInputGuard(tab)
    }
  }


  private async trusted<T>(tab: Tab, action: () => Promise<T>): Promise<T | null> {
    if (!tab.cdp.ensure()) return null
    try {
      return await this.liftGuard(tab, async () => this.trustedInput(action))
    } catch {
      return null
    }
  }

  private async trustedInput<T>(action: () => Promise<T>): Promise<T> {
    this.injectingInput = true
    try {
      return await action()
    } finally {
      this.injectingInput = false
    }
  }

  setAgentDriving(on: boolean, reason = ''): void {
    this.agentDriving = on
    this.handoffReason = on ? '' : reason
    // A handoff opens the page full size so the person can sign in or pass a check comfortably;
    // handing back puts it in the panel again.
    if (!on && reason !== '' && this.hasPage()) this.expanded = true
    if (on) this.expanded = false
    for (const tab of this.tabs) void this.refreshInputGuard(tab)
    this.emit()
  }

  // ---- tabs and the window ----------------------------------------------------------------

  private activeTab(): Tab | null {
    return pickTab(this.tabs, this.activeId, this.current)
  }

  /** The tab in front of the person, whichever partition it is in. */
  private shownTab(): Tab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? this.tabs[0] ?? null
  }

  /** Profiles: the agent browses in this partition from now on (see BrowserDriver.usePartition). */
  usePartition(partition: string): void {
    const next = partition.trim() === '' ? this.partition : partition
    if (next === this.current) return
    this.current = next
    const tab = pickTab(this.tabs, this.activeId, next)
    if (tab !== null && tab.id !== this.activeId) {
      this.activeId = tab.id
      this.layout()
    }
    this.emit()
  }

  private createTab(initialUrl?: string, partition: string = this.current): Tab | null {
    if (this.tabs.length >= this.maxTabs) return null
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    view.setBackgroundColor('#ffffff')

    const tab: Tab = {
      id: `tab-${++this.tabSeq}`,
      partition,
      view,
      cdp: new Cdp(view.webContents.debugger),
      ready: false,
      applied: null,
      scale: 1,
      status: null,
      loadError: null,
      siteCss: [],
    }
    this.tabs.push(tab)
    this.activeId = tab.id
    this.configureSession(view.webContents.session, partition)
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
      // A popup opens in the view its site needs, with the emulation in place before the first request.
      this.currentView = this.sites.viewFor(initialUrl)
      void this.prepare(tab)
        .then(() => view.webContents.loadURL(initialUrl))
        .catch(() => undefined)
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
      // A popup opens with its opener's sign-ins.
      this.createTab(policy.url, tab.partition)
      return { action: 'deny' }
    })

    wc.on('before-input-event', (event, input) => {
      // Escape shrinks the full-size page back into the panel, as the bar says.
      if (this.expanded && input.type === 'keyDown' && input.key === 'Escape' && !input.shift && !input.control && !input.alt && !input.meta) {
        event.preventDefault()
        this.setExpanded(false)
        return
      }
      // A key the agent sends itself must still reach the page.
      if (this.agentDriving && !this.injectingInput) event.preventDefault()
    })

    wc.on('did-navigate', (_event, _url, httpResponseCode) => {
      tab.status = httpResponseCode > 0 ? httpResponseCode : null
      // Inserted CSS belongs to the old document; ask for it again on the new one.
      this.inputCss.delete(tab.id)
      tab.siteCss = []
      void this.refreshInputGuard(tab)
      this.emit()
    })
    wc.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      // -3 is an aborted load (a redirect or a newer navigation), not a failure.
      if (isMainFrame && errorCode !== -3) tab.loadError = `net::${errorDescription}`
    })
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || this.opening) return
      // Following a link to another site: present the way that site needs, as browser_open would.
      const from = siteOf(safeUrl(tab.view))
      const to = siteOf(details.url)
      if (to === null || to === from) return
      const wanted = this.sites.viewFor(details.url)
      if (sameView(wanted, this.currentView)) return
      this.currentView = wanted
      void this.applyEmulation(tab).then(() => {
        this.layout()
        this.emit()
      })
    })
    wc.on('dom-ready', () => {
      void this.applySiteFixes(tab)
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

  private configureSession(session: Session, partition: string): void {
    if (this.sessionsReady.has(partition)) return
    this.sessionsReady.add(partition)

    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)
    // No Electron or app token in the user agent: sites treat those as an embedded shell.
    try {
      session.setUserAgent(userAgentFor(presetView('desktop'), this.engine), 'en-US,en;q=0.9')
    } catch {
      // A session that refuses a user agent keeps its own.
    }
    // Headers and a user agent the agent chose for one site. The only onBeforeSendHeaders listener on
    // this partition; it must call back on every path or that request hangs.
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      try {
        const extra = this.sites.headersFor(details.url)
        const view = this.sites.get(details.url)?.view
        if (extra === null && (view === undefined || view.userAgent === '')) {
          callback({})
          return
        }
        const headers = { ...details.requestHeaders }
        if (view !== undefined && view.userAgent !== '') headers['User-Agent'] = view.userAgent
        for (const [name, value] of Object.entries(extra ?? {})) headers[name] = value
        callback({ requestHeaders: headers })
      } catch {
        callback({})
      }
    })
    this.sessionCleanups.push(() => session.webRequest.onBeforeSendHeaders(null))

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
    // The page keeps the size it is emulating; the view is that page drawn scaled to fit the slot.
    const fit = fitView(this.slotRect(), this.currentView)
    this.lastFit = fit
    for (const tab of this.tabs) {
      if (tab.view.webContents.isDestroyed()) continue
      try {
        tab.view.setBounds(fit.bounds)
        tab.view.setVisible(visible && tab.id === this.activeId)
      } catch {
        // Bounds cannot be set on a view whose window has gone.
      }
      void this.rescale(tab, fit)
    }
  }

  private async refreshInputGuard(tab: Tab): Promise<void> {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    const wanted = (): boolean => this.agentDriving && (this.lifted.get(tab.id) ?? 0) === 0
    const current = this.inputCss.get(tab.id)
    if (wanted()) {
      if (current !== undefined) return
      const token = ++this.guardSeq
      this.inputCss.set(tab.id, { token, key: null })
      try {
        const key = await wc.insertCSS('html,body{pointer-events:none !important}')
        const now = this.inputCss.get(tab.id)
        if (now?.token === token && wanted()) {
          now.key = key
          return
        }
        // Things changed while it was being inserted (a navigation, the agent acting, a handover).
        await wc.removeInsertedCSS(key).catch(() => undefined)
        if (now?.token === token) {
          this.inputCss.delete(tab.id)
          void this.refreshInputGuard(tab)
        }
      } catch {
        if (this.inputCss.get(tab.id)?.token === token) this.inputCss.delete(tab.id)
      }
    } else if (current !== undefined) {
      this.inputCss.delete(tab.id)
      if (current.key !== null) await wc.removeInsertedCSS(current.key).catch(() => undefined)
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

function sameView(a: ViewSpec, b: ViewSpec): boolean {
  return a.mode === b.mode && a.width === b.width && a.height === b.height && a.dpr === b.dpr && a.zoom === b.zoom && a.userAgent === b.userAgent && a.touch === b.touch
}

function compiles(source: string): boolean {
  try {
    // Compiled only, never run: it tells an expression from a list of statements.
    new Script(source)
    return true
  } catch {
    return false
  }
}

function clampMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1500
  return Math.min(10_000, Math.max(50, Math.round(value)))
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... (${text.length - max} more characters)`
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
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
