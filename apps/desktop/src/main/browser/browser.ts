/**
 * The agent's own browser. Each tab's page is a <webview> the renderer hosts inside the browser card
 * (embed.ts), so it scrolls, clips and resizes with the card in the same frame; this class stays in charge
 * of the page through the guest's webContents (debugger, emulation, site fixes, trusted input). Only when no
 * renderer can host a tab (onboarding, the smoke test) does a tab get its own offscreen WebContentsView.
 * It has its own session partition, so it is separate from the app UI and keeps its sign-ins across runs.
 *
 * Two modes:
 *   - the agent drives (the default): the person's mouse and keyboard are ignored, and only public
 *     web addresses may be opened;
 *   - the person drives (browser_handoff or the panel's Take over): input works and private or
 *     local addresses are allowed, because a human asked for them.
 *
 * Page helpers live in ./outline.ts as plain JavaScript so they can be tested in a real Chromium.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'

import { app, BrowserWindow, clipboard as systemClipboard, Menu, screen, session as electronSession, shell, webContents as allWebContents, WebContentsView } from 'electron'
import type { DownloadItem, Session, WebContents, WebPreferences } from 'electron'

import type { BrowserBounds, BrowserHandOver, BrowserPageSpec, BrowserState, BrowserTab } from '@agent/core'

import { makeHandOver, pageMenuItems } from './hand-over'

import { Cdp, KEY_NAMES } from './cdp'
import { emailsIn } from './people'
import { PRESENCE_SCRIPT } from './presence'
import { watchDevtools } from './devtools'
import type { NetEntry } from './devtools-log'
import {
  acceptLanguageFor,
  chromeVersionOf,
  languageListFor,
  emulationCommands,
  fitView,
  presetView,
  shapedView,
  resolveView,
  userAgentFor,
  viewLabel,
  type EngineInfo,
  type FitResult,
  type ViewSpec,
} from './emulation'
import { currentOwner, ownerLabel } from './owner'
import { liveRuns } from '../runtime/live-runs'
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
import type { ActRequest, BrowserDriver, BrowserProDriver, FixRequest, GuideRequest, ViewRequest } from './types'
import { planWindowOpen, popupSize } from './popup'
import type { BrowserVault } from '../vault/browser-vault'
import { attachVaultTo, debuggerLink } from './vault-link'
import { formatUpload, uploadFiles, type UploadHost, type UploadTarget } from './upload'
import { brandLook, type BrandLook } from '../../shared/brand'
import { formatGuide, GuideRuns, guideShowsFullSize, runGuide, type GuideHost } from './guide'
import { evaluateIn, FrameSessions } from './guide-host'
import { GuideLog, TAIL_MS } from './guide-log'
import { dialogsScript, guideClearScript, guideModeScript, guideRestyleScript, pickMarkScript } from './guide-page'
import { parseView, PrivateGuide, viewWatchScript, type PrivateOverlay, type ViewInfo } from './guide-private'
import { alive, ifAlive, whileAlive } from '../alive'
import { pickTab } from './tab-pick'
import { siteTabPlan } from './site-tab'
import { onRunEnded, RunTabs, SWEEP_MS } from './run-tabs'
import { checkBrowserUrl } from './url-policy'
import { PAGE_SCRIPT_MS, PageTimeout, WAIT_MAX_S, orFallback, waitAnswer, withDeadline } from './deadline'
import { EMBED_WAIT_MS, guardWebview, isEmbeddedGuest } from './embed'
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
  waitForScript,
  type ReadTarget,
} from './outline'

const PARTITION = 'persist:agent-browser'

/**
 * Permissions a page may hold without a person deciding: the same ones a fresh Chrome profile answers `prompt`
 * or `granted` to. Camera, microphone, location, screen capture, clipboard reading and device access are not
 * here, so they stay refused.
 */
const BENIGN_PERMISSIONS = new Set([
  'fullscreen',
  'pointerLock',
  'notifications',
  'clipboard-sanitized-write',
  'mediaKeySystem',
  'speaker-selection',
  'openExternal',
  'background-sync',
  'storage-access',
  'top-level-storage-access',
])
/** The platform version the engine itself reports in `navigator.userAgentData`, so the top frame matches its workers. */
function platformVersionOf(platform: string): string {
  if (platform === 'win32') {
    const version = process.getSystemVersion() || '10.0.0'
    const build = Number(version.split('.')[2] ?? '0')
    return build >= 22_000 ? '19.0.0' : '10.0.0'
  }
  if (platform === 'darwin') return '10.15.7'
  return '6.5.0'
}

/** The screen the panel is on, in CSS pixels, so the page's screen is a real one and not its own viewport. */
function primaryScreen(): { width: number; height: number } | undefined {
  try {
    const display = screen.getPrimaryDisplay()
    const size = display.size
    return { width: Math.round(size.width), height: Math.round(size.height) }
  } catch {
    return undefined
  }
}

/** The app's own locale, so navigator.languages and Accept-Language agree with Intl and with the person. */
function appLocale(): string {
  try {
    return app.getLocale() ?? ''
  } catch {
    return ''
  }
}

const MAX_TABS = 5
const EMPTY_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 0, height: 0, visible: false }

/** A tab whose <webview> the renderer is creating; it becomes a Tab once the guest is handed over. */
interface PendingTab {
  partition: string
  spec: ViewSpec
  /** The guest page, null when no renderer hosted it in time (the tab then opens offscreen), or closed. */
  resolve: (outcome: WebContents | null | 'closed') => void
}

interface Tab {
  id: string
  /** The session partition: General's original one, or a profile's own (its cookies and sign-ins). */
  partition: string
  /** The page: the guest of the renderer's <webview> for this tab, or the offscreen view's own. */
  wc: WebContents
  /** Only a tab no renderer could host has a native view of its own; it is never added to the window. */
  view: WebContentsView | null
  /** The view this tab was set up with, before it takes the shape of its box. The renderer places the page by it. */
  spec: ViewSpec
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
  /** Where the person's own tabs open until they pick another browser profile. Defaults to `partition`. */
  personPartition?: string
  /** The person closed the tab an agent handed them (browser_handoff), so its waiting question can be answered. */
  onHandoffClosed?: () => void
  maxTabs?: number
  onState?: (state: BrowserState) => void
  /**
   * Hand a page to the agent (toolbar button, the page's right-click menu): where its note and picture are written,
   * the name the person gave their agent (for the menu line), and where the result goes (the message box).
   */
  handOver?: { root: string; agentName: () => string; deliver: (page: BrowserHandOver) => void }
  openExternal?: (url: string) => Promise<void>
  tempRoot?: string
  /** Where what the browser learns about sites is kept (a JSON file under userData). Null keeps it in memory. */
  sitesFile?: string | null
  /** The app's brand look now (his theme and accent setting): the guide's ring and label are drawn in it. */
  look?: () => BrandLook
  /**
   * Guides drawn in a window of their own that screen sharing leaves out (main/overlay/). `on` is his setting and
   * what this computer can really hide, read live; `overlay` makes one overlay, called only when a ring is first
   * drawn that way. Without this the page draws the ring itself, as before.
   */
  privateGuides?: { on: () => boolean; overlay: () => PrivateOverlay }
}

export class AgentBrowser implements BrowserDriver, BrowserProDriver {
  /** The Vault serves every page from now on: tabs already open get it at once. */
  setVault(vault: BrowserVault): void {
    this.vault = vault
    for (const tab of this.tabs) if (tab.ready) void this.attachVault(tab.wc, () => this.personTab === tab.id)
  }

  private async attachVault(wc: WebContents, person: () => boolean): Promise<void> {
    const vault = this.vault
    if (vault === null || !alive(wc) || this.vaultAttached.has(wc)) return
    this.vaultAttached.add(wc)
    try {
      // The top frame only: a third-party frame (a sign-in window, a human-verification widget) must run
      // exactly as it would in Chrome, with no injected world, no binding and no patched credentials.
      await attachVaultTo(vault, wc, { person })
    } catch {
      this.vaultAttached.delete(wc)
    }
  }

  private window: BrowserWindow | null
  private readonly partition: string
  /**
   * The person's own sign-ins: the tabs they open go here (their browser profile, like Chrome's). Agents never
   * browse in it unless a profile borrows it; an agent with no profile keeps `partition`.
   */
  private current: string
  private readonly maxTabs: number
  private readonly onState: (state: BrowserState) => void
  private readonly onHandoffClosed: () => void
  private readonly openExternal: (url: string) => Promise<void>
  private readonly runDir: string
  private readonly downloadsDir: string
  private readonly screenshotsDir: string
  private readonly tabs: Tab[] = []
  /** New tabs waiting for the renderer's <webview> (see embed.ts), by tab id. */
  private readonly pending = new Map<string, PendingTab>()
  /** Listeners on the main window's webContents, removed when the browser leaves that window. */
  private readonly windowCleanups: Array<() => void> = []
  /** The pointer guard per tab: its insertCSS key once inserted, and a token so a stale insert removes itself. */
  private readonly inputCss = new Map<string, { token: number; key: string | null }>()
  /** How many agent actions are under way per tab with the guard lifted. */
  private readonly lifted = new Map<string, number>()
  private guardSeq = 0
  /** Windows a page opened with window.open (a sign-in popup), kept alive while their flow runs. */
  private readonly popups = new Set<BrowserWindow>()
  /** The Vault in the page: autofill, offers to save, passkeys (vault/browser-vault.ts). Set once the vault exists. */
  private vault: BrowserVault | null = null
  private readonly vaultAttached = new WeakSet<WebContents>()
  /** When each tab last had a real click, tap or key, so a window.open with no click behind it stays refused. */
  private readonly lastGesture = new Map<string, number>()
  private readonly downloads: string[] = []
  private readonly sessionCleanups: Array<() => void> = []
  /** Which run opened each tab, and which close when their run ends (run-tabs.ts). */
  private readonly runTabs = new RunTabs()
  /** Tabs kept open with nobody's run on them, throttled in the background until an agent picks them up. */
  private readonly idled = new Set<string>()
  /** The tab that opened each sign-in window, so the window goes when the tab does. */
  private readonly popupOpener = new Map<BrowserWindow, string>()
  private readonly offRunEnd: () => void
  private readonly sweepTimer: ReturnType<typeof setInterval>
  /** Guides showing now: each restyles its rings when his theme or accent changes (restyleGuides). */
  private readonly liveGuides = new Set<() => Promise<void>>()
  private readonly look: (() => BrandLook) | undefined
  private readonly privateGuides: AgentBrowserOptions['privateGuides']
  /** Guides showing now: each moves its drawing into or out of the page when his privacy setting changes. */
  private readonly livePrivacy = new Set<() => Promise<void>>()
  /** Each tab's frames, cross-site ones included, for the guide (guide-host.ts). */
  private readonly frameSessions = new Map<string, FrameSessions>()
  /** The guided session running on each tab, and who started it. */
  private readonly guiding = new GuideRuns()
  /** Every guided session's step log (browser_guide_log). */
  private readonly guides = new GuideLog()

  private activeId: string | null = null
  private bounds: BrowserBounds = { ...EMPTY_BOUNDS }
  /**
   * The tab the person is using, if any. Only that tab is theirs: agents keep working in their own tabs, and
   * an agent whose tab the person took simply opens a new one. Closing that tab hands it back.
   */
  private personTab: string | null = null
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
  /** Full screen: the page has the whole screen, with only the browser's toolbar. Only ever on with `expanded`. */
  private fullScreen = false
  private readonly handOverTo: AgentBrowserOptions['handOver']
  /** Tabs the person handed to the agent (hand-over.ts): an agent may be told to carry on in one of these. */
  private readonly handedTabs = new Set<string>()

  constructor(options: AgentBrowserOptions) {
    // Set by attach() below, which also guards the window's <webview>s.
    this.window = null
    this.partition = options.partition ?? PARTITION
    this.current = this.partition
    this.maxTabs = Math.max(1, options.maxTabs ?? MAX_TABS)
    this.onState = options.onState ?? (() => undefined)
    this.onHandoffClosed = options.onHandoffClosed ?? (() => undefined)
    this.handOverTo = options.handOver
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))
    this.look = options.look
    this.privateGuides = options.privateGuides

    const root = options.tempRoot ?? tmpdir()
    this.runDir = mkdtempSync(join(root, 'agent-browser-'))
    this.downloadsDir = join(this.runDir, 'downloads')
    this.screenshotsDir = join(this.runDir, 'screenshots')
    mkdirSync(this.downloadsDir, { recursive: true })
    mkdirSync(this.screenshotsDir, { recursive: true })

    this.sites = new SiteStore(options.sitesFile ?? null)
    this.current = this.sites.person() ?? options.personPartition ?? this.partition
    this.currentView = this.sites.defaultView()
    let engineUa = ''
    try {
      engineUa = options.window.webContents.getUserAgent()
    } catch {
      engineUa = ''
    }
    this.engine = { chromeVersion: chromeVersionOf(engineUa), platform: process.platform, platformVersion: platformVersionOf(process.platform), locale: appLocale(), screen: primaryScreen() }

    // A run that ends closes the tabs it opened (helpers and routines at once, the main agent after a few idle minutes).
    this.offRunEnd = onRunEnded((owner, graceMs) => this.endRun(owner, graceMs))
    this.sweepTimer = setInterval(() => ifAlive('browser sweep', () => this.sweepTabs()), SWEEP_MS)
    this.sweepTimer.unref?.()

    this.attach(options.window)
  }

  // ---- runs own their tabs ------------------------------------------------------------------

  /** A run ended: the tabs it opened close after `graceMs`, unless it browses again first (run-tabs.ts). */
  endRun(owner: string, graceMs = 0): void {
    if (this.destroyed) return
    // A guide never outlives the run that started it: its ring and listeners go with it.
    this.guiding.endOwner(owner)
    this.runTabs.end(owner, Date.now() + graceMs)
    if (graceMs === 0) this.sweepTabs()
  }

  /** Closes the tabs that are due: ended runs' tabs, and shown ones of ended runs once they are no longer shown. */
  private sweepTabs(): void {
    if (this.destroyed || !this.runTabs.pending()) return
    const shown = this.bounds.visible && this.bounds.width > 0 ? (this.shownTab()?.id ?? null) : null
    const plan = this.runTabs.sweep(Date.now(), {
      open: [...this.tabs.map((tab) => tab.id), ...this.pending.keys()],
      personTab: this.personTab,
      shown,
      driving: this.ownerTabs,
    })
    for (const owner of plan.drop) {
      this.ownerTabs.delete(owner)
      this.ownerPartitions.delete(owner)
    }
    for (const id of plan.close) this.closeTab(id)
    for (const id of plan.idle) this.idleTab(id)
  }

  /** A tab kept with no run on it: throttled in the background, so it costs little until it is needed again. */
  private idleTab(id: string): void {
    const tab = this.tabs.find((each) => each.id === id)
    if (tab === undefined || this.idled.has(id)) return
    this.idled.add(id)
    try {
      if (!tab.wc.isDestroyed()) tab.wc.setBackgroundThrottling(true)
    } catch {
      // A tab closing as this runs needs nothing.
    }
  }

  /**
   * An agent picked a kept tab up again: it runs at full speed again, embedded or offscreen. (An embedded tab that
   * stayed throttled after being picked up kept its timers slowed while hidden, so waits on it crawled.)
   */
  private wakeTab(tab: Tab): void {
    if (!this.idled.delete(tab.id)) return
    try {
      if (!tab.wc.isDestroyed()) tab.wc.setBackgroundThrottling(false)
    } catch {
      // Closing.
    }
  }

  /** The tabs the acting agent owns, one line each, for its own tool answers. */
  private ownTabLines(owner: string): string[] {
    const ids = this.runTabs.tabsOf(owner, { open: this.tabs.map((tab) => tab.id), driving: this.ownerTabs })
    return ids.map((id) => {
      const tab = this.tabs.find((each) => each.id === id)
      return `- ${id}${this.ownerTabs.get(owner) === id ? ' (current)' : ''}: ${tab === undefined ? '' : safeUrl(tab.wc)}`
    })
  }

  /** browser_open with new_tab: the agent's page opens in a fresh tab of its own; its other tabs stay open and its. */
  async openNewTab(raw: string): Promise<string> {
    const owner = currentOwner()
    if (owner !== undefined) this.ownerTabs.delete(owner)
    const result = await this.open(raw)
    const id = owner === undefined ? undefined : this.ownerTabs.get(owner)
    return id === undefined ? result : `Opened in a new tab (${id}).\n\n${result}`
  }

  /**
   * browser_close: the acting agent closes its current tab, one of its tabs by id, or all of them. Never the person's
   * tab, and never one another agent is driving.
   */
  async closeOwnTab(id?: string, all = false): Promise<string> {
    const owner = currentOwner()
    if (owner === undefined) return 'Only an agent closes its own tabs this way.'
    const mine = this.runTabs.tabsOf(owner, { open: this.tabs.map((tab) => tab.id), driving: this.ownerTabs })
    const wanted = all ? mine : [id === undefined || id.trim() === '' ? (this.ownerTabs.get(owner) ?? '') : id.trim()]
    if (wanted.length === 0 || wanted[0] === '') return 'You have no tab open.'
    const closed: string[] = []
    const refused: string[] = []
    for (const tabId of wanted) {
      if (!this.tabs.some((tab) => tab.id === tabId) && !this.pending.has(tabId)) {
        refused.push(`${tabId}: no such tab`)
        continue
      }
      if (tabId === this.personTab || (this.runTabs.ownerOf(tabId) === undefined && this.ownerTabs.get(owner) !== tabId)) {
        refused.push(`${tabId}: not yours (the person's, or nobody's to close)`)
        continue
      }
      const other = [...this.ownerTabs].find(([who, tab]) => tab === tabId && who !== owner)
      if (other !== undefined || this.runTabs.isShared(tabId)) {
        // A shared site tab or another agent's: this agent lets go of it, the tab stays.
        if (this.ownerTabs.get(owner) === tabId) this.ownerTabs.delete(owner)
        refused.push(`${tabId}: shared with another agent, so you let go of it and it stays open`)
        continue
      }
      if (this.runTabs.ownerOf(tabId) !== owner && this.ownerTabs.get(owner) !== tabId) {
        refused.push(`${tabId}: another agent's`)
        continue
      }
      this.closeTab(tabId)
      closed.push(tabId)
    }
    const left = this.ownTabLines(owner)
    return [
      closed.length === 0 ? 'Closed nothing.' : `Closed ${closed.join(', ')}.`,
      ...(refused.length === 0 ? [] : ['Kept:', ...refused.map((line) => `- ${line}`)]),
      left.length === 0 ? 'You have no tabs open now.' : 'Your tabs still open:',
      ...left,
    ].join('\n')
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

  /** Which run a tab belongs to (it opened it, or drives it now), in plain words, with the id that stops it. */
  private ownerFacts(tabId: string): { owner?: string; ownerLabel?: string; ownerRunId?: string } {
    let owner = this.runTabs.ownerOf(tabId)
    if (owner === undefined) for (const [who, tab] of this.ownerTabs) if (tab === tabId) owner = who
    if (owner === undefined) return {}
    const run = liveRuns.byOwner(owner)[0]
    const runId = run?.id ?? (owner.startsWith('helper:') ? owner.slice(7) : undefined)
    return { owner, ownerLabel: ownerLabel(owner), ...(runId === undefined ? {} : { ownerRunId: runId }) }
  }

  state(): BrowserState {
    // The panel shows the tab in front, whichever profile it belongs to.
    const active = this.shownTab()
    const tabs: BrowserTab[] = [
      ...this.tabs.map((tab) => ({
        id: tab.id,
        title: safeTitle(tab.wc),
        url: safeUrl(tab.wc),
        active: tab.id === this.activeId,
        partition: tab.partition,
        embed: tab.view === null,
        view: pageSpecOf(tab.spec),
        ...this.ownerFacts(tab.id),
      })),
      ...[...this.pending].map(([id, waiting]) => ({
        id,
        title: '',
        url: '',
        active: id === this.activeId,
        partition: waiting.partition,
        embed: true,
        view: pageSpecOf(waiting.spec),
      })),
    ].sort((a, b) => tabNumber(a.id) - tabNumber(b.id))
    return {
      url: active === null ? '' : safeUrl(active.wc),
      title: active === null ? '' : safeTitle(active.wc),
      tabs,
      visible: this.bounds.visible,
      agentActive: this.personTab === null || this.personTab !== (this.shownTab()?.id ?? null),
      needsUser: this.handoffReason !== '',
      handoffReason: this.handoffReason,
      expanded: this.expanded,
      fullScreen: this.fullScreen && this.expanded,
      muted: this.sites.muted(),
      personPartition: this.current,
      audible: this.tabs.some((tab) => safeAudible(tab.wc)),
      view: {
        mode: this.currentView.mode,
        label: viewLabel(this.effectiveView()),
        width: this.currentView.width,
        height: this.currentView.height,
        scale: Math.round(this.lastFit.scale * 1000) / 1000,
      },
    }
  }

  /** While the person drives, the agent's own input waits: one pair of hands at a time. */
  private pausedLine(): string {
    return 'The person is using this tab right now. Leave it to them: open your own page with browser_open (it opens a new tab for you) and carry on there, or wait until they hand this one back.'
  }

  /** The agent acting now is on the tab the person is using. */
  private heldByPerson(): boolean {
    return this.personTab !== null && this.activeTab()?.id === this.personTab
  }

  /** The page over the whole app window (the person helping out), or back in the chat panel. */
  setExpanded(on: boolean): void {
    if (this.expanded === on) return
    this.expanded = on
    this.emit()
  }

  /**
   * Full screen for the browser: the window takes the whole screen and the page keeps only its own toolbar. Turning
   * it on opens the page over the window first; leaving the browser view by any road leaves full screen too.
   */
  setFullScreen(on: boolean): void {
    if (on && !this.hasPage()) return
    if (this.fullScreen === on && (!on || this.expanded)) return
    this.fullScreen = on
    if (on) this.expanded = true
    this.windowFullScreen(on)
    this.emit()
  }

  private windowFullScreen(on: boolean): void {
    try {
      const win = this.window
      if (win !== null && !win.isDestroyed() && win.isFullScreen() !== on) win.setFullScreen(on)
    } catch {
      // A window that cannot go full screen still shows the layout.
    }
  }

  /**
   * The person hands a page to the agent: the tab in front, or the one whose menu was used. Its address, title,
   * selection, picture and tab id go to the message box (hand-over.ts). False when there is no page to hand over.
   */
  async handOverPage(tabId?: string, selection?: string): Promise<boolean> {
    const to = this.handOverTo
    const tab = tabId === undefined ? this.shownTab() : (this.tabs.find((each) => each.id === tabId) ?? null)
    if (to === undefined || tab === null || tab.wc.isDestroyed()) return false
    const page = await makeHandOver(to.root, {
      tabId: tab.id,
      url: safeUrl(tab.wc),
      title: safeTitle(tab.wc),
      selection: selection ?? (async () => String(await tab.wc.executeJavaScript('String(window.getSelection ? window.getSelection() : "")', true))),
      capture: async () => {
        const image = await withDeadline(tab.wc.capturePage(undefined, { stayHidden: true, stayAwake: true }), 6_000, 'The page capture')
        return image.isEmpty() ? null : image.toPNG()
      },
    })
    if (page === null) return false
    this.handedTabs.add(tab.id)
    try {
      to.deliver(page)
    } catch {
      // A window that is closing has no message box to fill.
    }
    return true
  }

  /**
   * browser_open with `tab`: the agent carries on in a tab the person handed over. Only a handed tab can be taken,
   * and the person can take it back at any time, as with any tab an agent drives.
   */
  async takeHandedTab(id: string): Promise<string> {
    const owner = currentOwner()
    const tab = this.tabs.find((each) => each.id === id)
    if (tab === undefined || tab.wc.isDestroyed()) return `There is no tab ${id} open. Open the address yourself with browser_open.`
    if (!this.handedTabs.has(id)) return `The person has not handed ${id} to you. Only a tab they hand over (Hand to you, in the browser) can be taken; open the address yourself with browser_open.`
    if (owner !== undefined) this.ownerTabs.set(owner, id)
    // It stays the person's page: no run's end closes it, and the agent cannot close it either (run-tabs.ts).
    this.runTabs.shared(id)
    if (this.personTab === id) {
      this.personTab = null
      this.handoffReason = ''
    }
    for (const each of this.tabs) void this.refreshInputGuard(each)
    this.emit()
    return `You are now on ${id}, the tab the person handed you.\n\n${await this.snapshot()}`
  }

  /** The page's right-click menu: Back, Reload, Copy, Paste and the hand-over, in the person's own tab. */
  private showPageMenu(tab: Tab, params: Electron.ContextMenuParams): void {
    const win = this.window
    if (win === null || win.isDestroyed() || tab.wc.isDestroyed()) return
    const items = pageMenuItems({
      agentName: this.handOverTo?.agentName() ?? '',
      url: safeUrl(tab.wc),
      canGoBack: tab.wc.navigationHistory.canGoBack(),
      hasSelection: params.selectionText.trim() !== '',
      editable: params.isEditable,
    })
    const run: Record<string, () => void> = {
      back: () => tab.wc.navigationHistory.goBack(),
      reload: () => tab.wc.reload(),
      copy: () => tab.wc.copy(),
      paste: () => tab.wc.paste(),
      'hand-over': () => void this.handOverPage(tab.id, params.selectionText),
    }
    const menu = Menu.buildFromTemplate(
      items
        .filter((item) => item.id !== 'hand-over' || this.handOverTo !== undefined)
        .map((item) => (item.id === 'separator' ? { type: 'separator' as const } : { label: item.label, enabled: item.enabled, click: () => run[item.id]?.() })),
    )
    menu.popup({ window: win })
  }

  /** The person's mute: every tab now and every tab opened later, until they turn it back on. */
  setMuted(on: boolean): void {
    this.sites.setMuted(on)
    for (const tab of this.tabs) {
      try {
        tab.wc.setAudioMuted(on)
      } catch {
        // A tab closing as this runs has nothing left to mute.
      }
    }
    this.emit()
  }

  /** The panel's own switch: the person picks a device; it is remembered for the site like the agent's choice. */
  async setViewMode(mode: ViewSpec['mode']): Promise<void> {
    await this.view({ mode })
  }

  async back(): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.wc)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    const wc = tab.wc
    if (!wc.navigationHistory.canGoBack()) return 'There is no earlier page.'
    wc.navigationHistory.goBack()
    await this.waitForLoad(tab)
    this.emit()
    return this.snapshot()
  }

  async reload(): Promise<void> {
    const tab = this.shownTab()
    if (tab === null) return
    tab.wc.reload()
    this.emit()
  }

  selectTab(id: string): void {
    const picked = this.tabs.find((tab) => tab.id === id)
    if (picked === undefined) return
    // Picking a tab never moves an agent into its sign-ins: each agent keeps its own profile.
    this.activeId = id
    this.layout()
    this.emit()
  }

  closeTab(id: string): void {
    const waiting = this.pending.get(id)
    if (waiting !== undefined) {
      // Closed before its page was even attached: the open that made it gives up.
      waiting.resolve('closed')
      for (const [owner, tabId] of this.ownerTabs) if (tabId === id) this.ownerTabs.delete(owner)
      this.runTabs.forget(id)
      if (this.activeId === id) this.activeId = this.tabs[this.tabs.length - 1]?.id ?? null
      this.emit()
      return
    }
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    const [tab] = this.tabs.splice(index, 1)
    if (tab === undefined) return
    this.guiding.endTab(tab.id, 'closed')
    this.frameSessions.get(tab.id)?.stop()
    this.frameSessions.delete(tab.id)
    for (const [owner, tabId] of this.ownerTabs) if (tabId === tab.id) this.ownerTabs.delete(owner)
    this.runTabs.forget(tab.id)
    this.handedTabs.delete(tab.id)
    this.idled.delete(tab.id)
    // A sign-in window the tab opened goes with it: nothing is left running for a page that is gone.
    for (const [popup, opener] of this.popupOpener) {
      if (opener !== tab.id) continue
      this.popupOpener.delete(popup)
      try {
        if (!popup.isDestroyed()) popup.destroy()
      } catch {
        // Already closed.
      }
    }
    // Closing the tab the person was using hands control back; one an agent handed them answers its wait.
    if (this.personTab === tab.id) {
      const handedOver = this.handoffReason !== ''
      this.personTab = null
      this.handoffReason = ''
      this.expanded = false
      if (handedOver) this.onHandoffClosed()
    }
    this.inputCss.delete(tab.id)
    this.lastGesture.delete(tab.id)
    // An embedded page ends when the renderer drops its <webview> (it no longer sees the tab); an offscreen one is closed here.
    if (tab.view !== null) {
      try {
        tab.wc.close()
      } catch {
        // Already closed.
      }
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

  /**
   * The person typed an address (or words to search) in the browser's own bar: it opens in the tab in front of
   * them, like any browser. Words with no dot become a search.
   */
  async personOpen(raw: string): Promise<void> {
    const url = addressOf(raw)
    if (url === null) return
    const tab = this.shownTab()
    if (tab === null || tab.wc.isDestroyed()) {
      // The person's first page: their tab, so it takes their clicks straight away.
      const made = await this.createTab(url)
      if (made !== null) {
        this.personTab = made.id
        for (const each of this.tabs) void this.refreshInputGuard(each)
        this.emit()
      }
      return
    }
    // Typing an address in a tab makes it the person's tab: his from now on, so no agent's run closes it.
    this.personTab = tab.id
    this.runTabs.givenToPerson(tab.id)
    for (const each of this.tabs) void this.refreshInputGuard(each)
    this.currentView = this.viewForTab(url, tab)
    await this.prepare(tab).catch(() => undefined)
    await tab.wc.loadURL(url).catch(() => undefined)
    this.emit()
  }

  /** A new tab for the person, in front, on Google. */
  async personNewTab(): Promise<void> {
    const tab = await this.createTab(NEW_TAB_PAGE)
    // A tab the person opened is theirs to use.
    if (tab !== null) {
      this.personTab = tab.id
      for (const each of this.tabs) void this.refreshInputGuard(each)
    }
    this.emit()
  }

  async openInSystem(): Promise<void> {
    const tab = this.activeTab()
    if (tab === null) return
    const url = safeUrl(tab.wc)
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
    // Only <webview>s the browser asked for may attach to this window, and only locked down (embed.ts).
    const host = win.webContents
    const onWillAttach = (event: Electron.Event, prefs: WebPreferences, params: Record<string, string>): void => {
      const wanted = (partition: string): boolean => [...this.pending.values()].some((waiting) => waiting.partition === partition)
      if (!guardWebview(prefs, params, wanted)) event.preventDefault()
    }
    host.on('will-attach-webview', onWillAttach)
    this.windowCleanups.push(() => host.removeListener('will-attach-webview', onWillAttach))
    // Full screen left by the system's own road (a key, the taskbar): the layout follows.
    const onLeaveFull = (): void => {
      if (!this.fullScreen) return
      this.fullScreen = false
      this.emit()
    }
    win.on('leave-full-screen', onLeaveFull)
    this.windowCleanups.push(() => win.removeListener('leave-full-screen', onLeaveFull))
    this.layout()
    this.emit()
  }

  detach(): void {
    if (this.window === null) return
    for (const cleanup of this.windowCleanups.splice(0)) {
      try {
        cleanup()
      } catch {
        // The window is already gone.
      }
    }
    this.window = null
  }

  /**
   * The renderer's <webview> for a waiting tab is attached: adopt its guest page, once it is proven to be a
   * webview of this window in the tab's own session. False (and nothing changes) for anything else.
   */
  attachGuest(tabId: string, guestId: number, senderId: number | null): boolean {
    const waiting = this.pending.get(tabId)
    const win = this.window
    if (waiting === undefined || win === null || win.isDestroyed()) return false
    if (senderId !== null && senderId !== win.webContents.id) return false
    if (this.tabs.some((tab) => !tab.wc.isDestroyed() && tab.wc.id === guestId)) return false
    const guest = allWebContents.fromId(guestId)
    if (guest === undefined || !isEmbeddedGuest(guest, win.webContents.id, electronSession.fromPartition(waiting.partition))) return false
    waiting.resolve(guest)
    return true
  }

  /** A tab's page, for main-process code that needs it directly (the devtools tools). Null for an unknown tab. */
  tabWebContents(tabId?: string): WebContents | null {
    const tab = tabId === undefined ? this.activeTab() : (this.tabs.find((item) => item.id === tabId) ?? null)
    return tab === null || tab.wc.isDestroyed() ? null : tab.wc
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    clearInterval(this.sweepTimer)
    this.offRunEnd()
    for (const cleanup of this.sessionCleanups.splice(0)) {
      try {
        cleanup()
      } catch {
        // A session listener that cannot be removed is harmless at shutdown.
      }
    }
    for (const popup of this.popups) {
      if (popup.isDestroyed()) continue
      try {
        popup.destroy()
      } catch {
        // Already gone with the window.
      }
    }
    this.popups.clear()
    this.detach()
    for (const waiting of [...this.pending.values()]) waiting.resolve('closed')
    for (const tab of this.tabs.splice(0)) {
      // Embedded pages end with their window; only an offscreen view is closed by hand.
      if (tab.view === null) continue
      try {
        tab.wc.close()
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
    return tab !== null && isRealPage(tab.wc)
  }

  currentUrl(): string {
    const tab = this.activeTab()
    return tab === null ? '' : safeUrl(tab.wc)
  }

  /** The developer tools' one way in: the agent's current tab's webContents (never the view it is shown in). */
  devtoolsTarget(): Electron.WebContents | null {
    const tab = this.activeTab()
    return tab === null || tab.wc.isDestroyed() ? null : tab.wc
  }

  /** The person's Developer tools button: Chromium's own DevTools for the tab in front, in its own window. */
  openDevTools(): void {
    const tab = this.shownTab()
    if (tab === null) return
    const wc = tab.wc
    if (wc.isDestroyed()) return
    if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus()
    else wc.openDevTools({ mode: 'detach', activate: true })
  }

  /**
   * Runs script text in the page's main world, for learned apps (reference phone PageJs.direct): the
   * app injects the text itself, so the site's content security policy does not stop it. A promise
   * result is awaited. Rejects on a syntax error, a thrown error or the timeout.
   */
  async evaluateRaw(code: string, timeoutMs = 30_000): Promise<unknown> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.wc)) throw new Error('No page is open yet. Use browser_open with a web address.')
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`The page did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs)
    })
    try {
      return await Promise.race([tab.wc.executeJavaScript(code, true), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async open(raw: string, asked: ViewRequest | null = null): Promise<string> {
    if (this.heldByPerson()) {
      // The person took this agent's tab: the agent gets a fresh tab of its own instead of waiting.
      const owner = currentOwner()
      if (owner === undefined) return this.pausedLine()
      this.ownerTabs.delete(owner)
    }
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
    const tab = this.activeTab() ?? (await this.createTab())
    if (tab === null) return 'I could not open another browser tab.'

    this.blockedReason = ''
    const before = safeUrl(tab.wc)
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
    if (safeUrl(tab.wc) === before && before === '' && opened.verdict.refusal === 'load_error') {
      return `I could not open ${hostOf(policy.url)}. ${opened.verdict.evidence}`
    }
    this.layout()
    this.emit()
    return this.snapshotText(tab, { notes: opened.notes })
  }

  async snapshot(): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.wc)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    return this.snapshotText(tab, {})
  }

  async snapshotPro(options: { filter?: string; deep?: boolean }): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.wc)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    return this.snapshotText(tab, options)
  }

  private async snapshotText(tab: Tab, options: { filter?: string; deep?: boolean; notes?: string }, limitMs: number = PAGE_SCRIPT_MS): Promise<string> {
    let raw: unknown
    const script = snapshotScript({ ...(options.filter === undefined ? {} : { filter: options.filter }), ...(options.deep === undefined ? {} : { deep: options.deep }) })
    const silent = (error: PageTimeout): string => `URL: ${safeUrl(tab.wc)}\nTitle: ${safeTitle(tab.wc)}\n\n${error.message} Try again in a moment.`
    try {
      raw = await this.run(tab, script, limitMs)
    } catch (error) {
      // A page that does not answer at all is said so, with what is known about it, instead of waiting on.
      if (error instanceof PageTimeout) return silent(error)
      // A page mid-navigation has no document to read yet; give it a moment once.
      await this.settle(400)
      try {
        raw = await this.run(tab, script, limitMs)
      } catch (again) {
        if (again instanceof PageTimeout) return silent(again)
        throw again
      }
    }
    const result = parseSnapshot(raw)
    if (this.blockedReason !== '') {
      result.note = result.note === '' ? this.blockedReason : `${result.note} ${this.blockedReason}`
      this.blockedReason = ''
    }
    return formatSnapshot(result, {
      view: `${viewLabel(this.effectiveView())}${this.currentView.mode === 'fit' || !this.bounds.visible ? '' : `, shown at ${Math.round(this.lastFit.scale * 100)}% in the panel`}`,
      downloads: this.downloads.slice(-5),
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      ...(options.notes === undefined ? {} : { notes: options.notes }),
    })
  }

  async read(target: ReadTarget = {}): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.wc)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    let raw: unknown
    try {
      raw = await this.run(tab, readScript(target))
    } catch (error) {
      if (error instanceof PageTimeout) return `URL: ${safeUrl(tab.wc)}\nTitle: ${safeTitle(tab.wc)}\n\n${error.message}`
      throw error
    }
    const result = parseRead(raw)
    if (!result.ok) return result.reason
    const head = `URL: ${safeUrl(tab.wc)}\nTitle: ${safeTitle(tab.wc)}\n\n`
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
    if (tab === null || !isRealPage(tab.wc)) {
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
    if (tab === null || !isRealPage(tab.wc)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    if (signal?.aborted === true) return 'Stopped.'
    const limit = Math.max(1, Math.min(WAIT_MAX_S, Math.floor(seconds)))
    // The page loops on its own timer; the main process holds its own deadline too, so a hidden, starved or frozen
    // page can never keep the wait (and the helper in it) going past its limit.
    const wait = this.run(tab, waitForScript(query.text, query.selector, limit * 1000), limit * 1000 + 2_000).then(
      (value) => ({ value, timedOut: false }),
      (error: unknown) => {
        if (error instanceof PageTimeout) return { value: null as unknown, timedOut: true }
        throw error
      },
    )
    const outcome = await raceAbort(wait, signal)
    if (outcome === null) return 'Stopped.'
    const result = outcome.timedOut ? { ok: false, reason: '' } : parseAction(outcome.value)
    const reason = result.ok ? '' : ((result as { reason?: string }).reason ?? '')
    const seen = await this.seen(tab)
    this.emit()
    const answer = waitAnswer({ found: result.ok, reason, timedOut: outcome.timedOut }, query, limit, seen)
    if (reason !== '') return answer
    // The outline helps the next step, but only if the page answers quickly; the wait has already had its time.
    const outline = await orFallback(this.snapshotText(tab, {}, 5_000), 8_000, '')
    return outline === '' ? answer : `${answer}\n\n${outline}`
  }

  /** What the page shows right now (address, title, start of its text), or null when it does not answer in 3 s. */
  private async seen(tab: Tab): Promise<{ url: string; title: string; text: string } | null> {
    try {
      const raw = objectOf(await this.run(tab, pageTextScript(), 3_000))
      return {
        url: safeUrl(tab.wc),
        title: typeof raw['title'] === 'string' && raw['title'] !== '' ? raw['title'] : safeTitle(tab.wc),
        text: typeof raw['text'] === 'string' ? raw['text'] : '',
      }
    } catch {
      const url = safeUrl(tab.wc)
      return url === '' ? null : { url, title: safeTitle(tab.wc), text: '(the page did not answer when read; it may be busy, frozen or hidden)' }
    }
  }

  /** The page as it is drawn in the panel, as a small JPEG, for the still picture shown while it steps aside. */
  async frame(): Promise<string | null> {
    const tab = this.shownTab()
    if (tab === null || !isRealPage(tab.wc) || !this.bounds.visible) return null
    try {
      const image = await Promise.race([tab.wc.capturePage(undefined, { stayHidden: true }), new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000))])
      if (image === null || image.isEmpty()) return null
      return `data:image/jpeg;base64,${image.toJPEG(72).toString('base64')}`
    } catch {
      return null
    }
  }

  /** Why the last screenshot failed, in plain words for the tool's answer ('' after one that worked). */
  private shotProblem = ''

  screenshotProblem(): string {
    return this.shotProblem
  }

  /**
   * A PNG of the page at the size it is laid out at (1440x900 for desktop), not the small panel copy. Works with
   * the panel hidden: the capture paints a page that is out of sight without showing it; the debugger's own capture
   * is the fallback. Every step has a deadline, and a failure says truthfully what was tried.
   */
  async screenshot(): Promise<string | null> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.wc)) {
      this.shotProblem = 'No page is open yet. Use browser_open with a web address.'
      return null
    }
    let png: Buffer | null = null
    const tried: string[] = []
    try {
      // stayHidden: a page out of sight is painted for the capture without being shown; stayAwake keeps it running.
      const image = await withDeadline(tab.wc.capturePage(undefined, { stayHidden: true, stayAwake: true }), 6_000, 'The page capture')
      if (!image.isEmpty()) png = image.toPNG()
      else tried.push('the page capture came back empty')
    } catch (error) {
      tried.push(error instanceof PageTimeout ? 'the page capture did not answer in 6 s' : 'the page capture failed')
    }
    if (png === null && tab.ready) {
      // The debugger renders the page itself.
      try {
        const shot = objectOf(await withDeadline(tab.cdp.send('Page.captureScreenshot', { format: 'png' }), 8_000, 'The debugger capture'))
        if (typeof shot['data'] === 'string' && shot['data'] !== '') png = Buffer.from(shot['data'], 'base64')
        else tried.push('the debugger capture came back empty')
      } catch {
        tried.push('the debugger capture did not answer')
      }
    }
    if (png === null) {
      this.shotProblem = `The page ${safeUrl(tab.wc)} is open but could not be drawn (${tried.join('; ')}). It may be busy or frozen; try again in a moment, or read it with browser_read.`
      return null
    }
    this.shotProblem = ''
    try {
      const path = join(this.screenshotsDir, `shot-${Date.now()}-${++this.shotSeq}.png`)
      writeFileSync(path, png)
      return path
    } catch (error) {
      this.shotProblem = `The screenshot was taken but could not be saved: ${error instanceof Error ? error.message : String(error)}`
      return null
    }
  }

  async upload(target: UploadTarget, paths: string[]): Promise<string> {
    if (this.heldByPerson()) return this.pausedLine()
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.wc)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    await this.prepare(tab)
    if (!tab.cdp.ensure()) return 'ERROR: The page debugger is busy, so a file cannot be put into the page right now. Nothing was uploaded.'
    const wc = tab.wc
    const devtools = watchDevtools(wc)
    const host: UploadHost = {
      link: debuggerLink(wc),
      runPage: (code) => this.run(tab, code),
      click: async (at) => {
        const point = { x: at.x * this.zoomOf(tab), y: at.y * this.zoomOf(tab) }
        const scale = this.drawScale(tab)
        return (await this.trusted(tab, async () => {
          await tab.cdp.click(point, scale)
          return true
        })) === true
      },
      ...(devtools === null
        ? {}
        : {
            requestsSince: (since: number) =>
              devtools.network.all().filter((entry) => entry.wallTime >= since).map((entry) => ({ method: entry.method, url: entry.url, type: entry.type, status: entry.status })),
          }),
    }
    const outcome = await this.liftGuard(tab, async () => uploadFiles(host, target, paths))
    if (outcome === null || outcome === undefined) return 'ERROR: The page went away during the upload. Nothing was uploaded.'
    this.emit()
    if (!outcome.ok) return formatUpload(outcome)
    await this.settle(300)
    return `${formatUpload(outcome)}

${await this.snapshot()}`
  }

  // ---- the view: device, size, zoom ---------------------------------------------------------

  async view(request: ViewRequest): Promise<string> {
    const tab = this.activeTab()
    const url = tab === null ? '' : safeUrl(tab.wc)
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
    if (tab !== null && isRealPage(tab.wc) && changedIdentity) {
      tab.wc.reload()
      await this.waitForLoad(tab, 10_000)
      await this.settle(300)
    } else {
      await this.settle(150)
    }
    this.emit()
    const lines = [`View: ${viewLabel(next)}${next.mode === 'fit' ? '' : `, drawn at ${Math.round(this.lastFit.scale * 100)}% to fit the panel`}.`]
    if (request.asDefault === true) lines.push('This is now the default for sites I have not learned yet.')
    if (request.reset !== true && request.remember !== false && site !== null) lines.push(`Remembered for ${site}.`)
    if (tab !== null && isRealPage(tab.wc)) {
      try {
        const seen = await withDeadline(
          tab.wc.executeJavaScript(
            'JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent, touch: navigator.maxTouchPoints })',
          ) as Promise<unknown>,
          5_000,
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
    const url = tab === null ? '' : safeUrl(tab.wc)
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
    if (this.heldByPerson()) return this.pausedLine()
    if (tab === null || !isRealPage(tab.wc) || site === null) {
      return 'Open the site first (browser_open), then fix it.'
    }
    const wc = tab.wc
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
    if (this.heldByPerson()) return this.pausedLine()
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.wc)) {
      return 'No page is open yet. Use browser_open with a web address.'
    }
    const wc = tab.wc
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
    const wc = tab.wc
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
    const before = safeUrl(tab.wc)
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
    const moved = safeUrl(tab.wc) !== before ? ` The page moved to ${safeUrl(tab.wc)}.` : ''
    return `Clicked ${target.label}.${moved}${covered}\n\n${await this.snapshotText(tab, {})}`
  }

  // ---- guided click-through: his click is the feedback ---------------------------------------

  guideLog(): GuideLog {
    return this.guides
  }

  /**
   * browser_guide (guide.ts): the agent's tab becomes his for the guide (his mouse and keys reach it), shown to him (the
   * panel when it shows this tab, else full size over the window), each step's element is highlighted in turn and his
   * own action ends the step. Nothing is clicked for him. Ends at once with what happened; the tab goes back to the
   * agent after, the rings are gone, and the step log keeps what each step sent (browser_guide_log).
   */
  async guide(request: GuideRequest, signal?: AbortSignal): Promise<string> {
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.wc)) return 'No page is open yet. Use browser_open with a web address first, then guide.'
    if (request.steps.length === 0) return 'Pass the step to highlight (target and label), or steps.'
    await this.prepare(tab)
    let frames = this.frameSessions.get(tab.id)
    if (!tab.ready || tab.wc.isDestroyed()) return 'The page debugger is not available, so I cannot draw on this page right now.'
    if (frames === undefined) {
      frames = new FrameSessions(debuggerLink(tab.wc))
      this.frameSessions.set(tab.id, frames)
    }
    await frames.start()
    const owner = currentOwner() ?? 'person'
    const devtools = watchDevtools(tab.wc)
    if (devtools !== null) await devtools.start().catch(() => false)
    const session = this.guides.start({
      owner,
      tabId: tab.id,
      url: safeUrl(tab.wc),
      steps: request.steps,
      // A sensitive value (clipboard fill, a Vault item) is masked in every request the log shows or an app is made from.
      masks: request.steps.filter((step) => step.sensitive === true && typeof step.value === 'string').map((step) => step.value as string),
      ...(devtools === null ? {} : { network: (): NetEntry[] => devtools.network.all() }),
    })
    // One guide per tab: a new one takes over from the last.
    const entry = this.guiding.start(tab.id, owner)
    const onOuter = (): void => entry.abort.abort()
    signal?.addEventListener('abort', onOuter, { once: true })
    if (signal?.aborted === true) entry.abort.abort()
    const restore = this.enterGuide(tab, guideLine(1, request.steps.length, request.steps[0]?.label ?? ''))
    const wc = tab.wc
    const link = debuggerLink(wc)
    const sessions = frames
    const host: GuideHost = {
      frames: () => sessions.frames(),
      evaluate: (key, code) => evaluateIn(sessions, key, code),
      markIndex: async (index, token) => (await this.run(tab, pickMarkScript(index, token), 3_000).catch(() => false)) === true,
      page: async () => {
        const raw = objectOf(await this.run(tab, dialogsScript(), 3_000).catch(() => ({})))
        return {
          url: safeUrl(wc),
          title: safeTitle(wc),
          dialogs: Array.isArray(raw['dialogs']) ? raw['dialogs'].filter((d): d is string => typeof d === 'string') : [],
          text: typeof raw['text'] === 'string' ? raw['text'] : '',
        }
      },
      onNavigate: (listener) => {
        if (!alive(wc)) return () => undefined
        const handler = whileAlive(wc, 'guide navigation', (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
          if (details.isMainFrame && !details.isSameDocument) listener()
        })
        wc.on('did-start-navigation', handler)
        return () => ifAlive('guide navigation off', () => wc.removeListener('did-start-navigation', handler))
      },
      onJsDialog: (listener) =>
        link.onEvent((method, params) => {
          if (method === 'Page.javascriptDialogOpening') listener(String(params['message'] ?? ''))
        }),
      onReport: (listener) => sessions.onReport(listener),
      loading: () => alive(wc) && wc.isLoading(),
      ready: (ms) => this.waitForDom(tab, ms),
    }
    // Drawn in a window of its own when his setting says so, so a screen share never shows the ring.
    const privately = this.privateGuide(tab, sessions)
    const lookNow = this.look
    const restyle = async (): Promise<void> => {
      if (lookNow === undefined || !alive(wc)) return
      const look = lookNow()
      privately?.surface.refresh()
      const all = await withDeadline(sessions.frames(), 2_000).catch(() => [])
      await Promise.all(all.map((frame) => withDeadline(evaluateIn(sessions, frame.key, guideRestyleScript(look)), 2_000).catch(() => undefined)))
    }
    this.liveGuides.add(restyle)
    const reprivate = async (): Promise<void> => {
      if (privately === null || !alive(wc)) return
      const outside = privately.surface.outside()
      const all = await withDeadline(sessions.frames(), 2_000).catch(() => [])
      await Promise.all(all.map((frame) => withDeadline(evaluateIn(sessions, frame.key, guideModeScript(outside)), 2_000).catch(() => undefined)))
      privately.surface.refresh()
    }
    this.livePrivacy.add(reprivate)
    try {
      const timeoutMs = request.timeoutMs
      const result = await runGuide(host, request.steps, {
        ...(lookNow === undefined ? {} : { look: lookNow }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        signal: entry.abort.signal,
        token: session.id,
        ...(privately === null ? {} : { surface: privately.surface }),
        clipboard: { read: () => systemClipboard.readText(), write: (text) => systemClipboard.writeText(text), clear: () => systemClipboard.clear() },
        pasteKey: process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V',
        onStep: (event) => {
          if (event.kind === 'start') {
            this.guides.stepStarted(session.id, event.n)
          } else if (event.kind === 'shown') {
            if (this.personTab === tab.id) {
              this.handoffReason = guideLine(event.n, request.steps.length, event.step.label)
              this.emit()
            }
          } else if (event.kind === 'end' && event.log !== undefined) {
            this.guides.stepEnded(session.id, event.log)
          }
        },
      })
      if (entry.endedBy === 'person' && result.outcome === 'cancelled') {
        result.outcome = 'done'
        result.note = 'He pressed Done in the browser, so the guide ended there.'
      } else if (entry.endedBy === 'closed') {
        result.note = 'He closed the tab, so the guide ended.'
      } else if (entry.endedBy === 'run') {
        result.note = 'The run that started the guide ended.'
      }
      this.guides.end(session.id, result)
      const freeze = setTimeout(() => this.guides.freeze(session.id), TAIL_MS + 500)
      freeze.unref?.()
      this.emit()
      return formatGuide(result, session.id)
    } finally {
      this.liveGuides.delete(restyle)
      this.livePrivacy.delete(reprivate)
      // The overlay window goes with the guide, whatever ended it (done, skip, tab closed, run end, a newer guide).
      privately?.stop()
      signal?.removeEventListener('abort', onOuter)
      this.guiding.finish(entry)
      if (alive(wc)) {
        // No ring is left behind in any frame, whatever ended the guide.
        const all = await withDeadline(sessions.frames(), 2_000).catch(() => [])
        await Promise.all(all.map((frame) => withDeadline(evaluateIn(sessions, frame.key, guideClearScript()), 2_000).catch(() => undefined)))
      }
      restore()
    }
  }

  /** His theme or accent changed: a ring showing now takes the new look at once (the next one is drawn in it anyway). */
  async restyleGuides(): Promise<void> {
    await Promise.all([...this.liveGuides].map((restyle) => restyle().catch(() => undefined)))
  }

  /** His "hide guides from screen sharing" setting changed: a ring showing now moves into or out of the page at once. */
  async refreshGuidePrivacy(): Promise<void> {
    await Promise.all([...this.livePrivacy].map((apply) => apply().catch(() => undefined)))
  }

  /**
   * The private drawing of one guide (guide-private.ts): keeps track of where the tab's page is in the app window
   * and of the window itself, for as long as the guide runs. Null when private guides are not set up.
   */
  private privateGuide(tab: Tab, sessions: FrameSessions): { surface: PrivateGuide; stop: () => void } | null {
    const options = this.privateGuides
    const win = this.window
    if (options === undefined || win === null || win.isDestroyed()) return null
    let view: ViewInfo | null = null
    let stopped = false
    let topKey: string | null = null
    const surface = new PrivateGuide({
      outside: () => !stopped && options.on(),
      overlay: options.overlay,
      owner: win,
      view: () => view,
      window: () => {
        try {
          if (win.isDestroyed()) return null
          const content = win.getContentBounds()
          return { content: { x: content.x, y: content.y }, zoom: win.webContents.getZoomFactor(), visible: win.isVisible() && !win.isMinimized() }
        } catch {
          return null
        }
      },
      look: () => this.look?.() ?? brandLook(),
      frameBox: async (frame) => {
        const box = await withDeadline(sessions.frameBox(frame.key), 2_000).catch(() => null)
        if (box === null) return null
        if (topKey === null) topKey = (await withDeadline(sessions.frames(), 2_000).catch(() => [])).find((each) => each.top)?.key ?? null
        if (topKey === null) return null
        const width = Number(
          await withDeadline(evaluateIn(sessions, topKey, 'innerWidth'), 2_000).catch(() => {
            topKey = null
            return Number.NaN
          }),
        )
        return Number.isFinite(width) && width > 0 ? { ...box, pageWidth: width } : null
      },
    })
    // Where the page's view is in the window, heard in the frame it changes (the script waits for a change).
    const watch = async (): Promise<void> => {
      let prev = ''
      while (!stopped && !win.isDestroyed()) {
        if (!options.on()) {
          prev = ''
          await this.settle(300)
          continue
        }
        const text = await withDeadline(win.webContents.executeJavaScript(viewWatchScript(tab.id, prev, 1_000)) as Promise<unknown>, 4_000).catch(() => null)
        if (stopped) return
        if (typeof text !== 'string') {
          await this.settle(250)
          continue
        }
        prev = text
        view = parseView(text)
        surface.refresh()
      }
    }
    void watch().catch(() => undefined)
    const onWindow = (): void => surface.refresh()
    const events = ['move', 'resize', 'minimize', 'restore', 'show', 'hide', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const
    for (const name of events) win.on(name as 'move', onWindow)
    return {
      surface,
      stop: () => {
        stopped = true
        ifAlive('private guide off', () => {
          if (!win.isDestroyed()) for (const name of events) win.removeListener(name as 'move', onWindow)
        })
        surface.dispose()
      },
    }
  }

  /** Hands the tab to the person for the guide and shows it to them; the returned function hands it back. */
  private enterGuide(tab: Tab, line: string): () => void {
    const before = { personTab: this.personTab, reason: this.handoffReason, expanded: this.expanded }
    const expandedHere = guideShowsFullSize({ panelVisible: this.bounds.visible, panelWidth: this.bounds.width, shownTab: this.shownTab()?.id ?? null, expanded: this.expanded }, tab.id)
    this.personTab = tab.id
    this.handoffReason = line
    this.activeId = tab.id
    this.wakeTab(tab)
    // The panel is hidden, folded, or on another tab: the page opens full size over the window for him.
    if (expandedHere) this.expanded = true
    for (const each of this.tabs) void this.refreshInputGuard(each)
    this.layout()
    this.emit()
    return () => {
      if (this.personTab === tab.id) this.personTab = before.personTab
      this.handoffReason = before.reason
      if (expandedHere) this.expanded = before.expanded
      for (const each of this.tabs) void this.refreshInputGuard(each)
      this.emit()
    }
  }

  /** Waits for the page's next document to be ready (dom-ready) or the load to stop, at most ms. */
  private async waitForDom(tab: Tab, ms: number): Promise<void> {
    const wc = tab.wc
    if (!alive(wc)) return
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        ifAlive('guide ready off', () => {
          wc.removeListener('dom-ready', finish)
          wc.removeListener('did-stop-loading', finish)
        })
        resolve()
      }
      const timer = setTimeout(finish, ms)
      wc.once('dom-ready', finish)
      wc.once('did-stop-loading', finish)
    })
  }

  // ---- running the agent's own script in the page --------------------------------------------

  async evaluate(code: string, seconds: number, signal?: AbortSignal): Promise<string> {
    if (this.heldByPerson()) return this.pausedLine()
    const tab = this.activeTab()
    if (tab === null || !isRealPage(tab.wc)) {
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
        this.liftGuard(tab, async () => tab.wc.executeJavaScript(wrapped, true) as Promise<unknown>),
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
    const wc = tab.wc
    if (wc.isDestroyed()) return
    if (safeUrl(tab.wc) === '') {
      // Attaching the debugger to a view that never loaded a document crashes Electron 44.
      await withDeadline(wc.loadURL('about:blank'), 10_000).catch(() => undefined)
    }
    tab.ready = tab.cdp.ensure()
    // The tab's developer tools record its network and console from here, before its first real page.
    if (tab.ready) watchDevtools(wc)
    // Every page from here on sees a whole Chrome window (presence.ts), before its own scripts run.
    // Chromium only runs such scripts while the Page domain is on.
    if (tab.ready) {
      await tab.cdp.send('Page.enable').catch(() => undefined)
      await tab.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PRESENCE_SCRIPT }).catch(() => undefined)
      // The guide keeps every cross-site frame's session from the start, so none is missed when the Vault turns
      // auto-attach on just below.
      if (!this.frameSessions.has(tab.id)) this.frameSessions.set(tab.id, new FrameSessions(debuggerLink(wc)))
      await this.attachVault(wc, () => this.personTab === tab.id)
    }
    await this.applyEmulation(tab)
  }

  /** The view as it is drawn right now: a plain desktop view takes the slot's shape. */
  private effectiveView(): ViewSpec {
    return shapedView(this.currentView, this.slotRect())
  }

  private async applyEmulation(tab: Tab): Promise<void> {
    const wc = tab.wc
    if (wc.isDestroyed()) return
    const view = this.effectiveView()
    const fit = fitView(this.slotRect(), view)
    if (tab.id === this.activeId || this.tabs.length === 1) this.lastFit = fit
    // The renderer places and scales the page by this spec (shared/page-place.ts).
    tab.spec = { ...this.currentView }
    // Pages are never drawn scaled by the engine any more: an embedded page is scaled by its card (a CSS
    // transform), an offscreen one is not shown at all. So input and screenshots are in plain page pixels.
    tab.scale = 1
    if (tab.ready) {
      // An embedded page lays out at its <webview>'s own size, which the card sets in the same frame as it moves.
      for (const command of emulationCommands(view, this.engine, { bounds: fit.bounds, scale: 1 }, tab.view === null)) {
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
    if (tab.view !== null) this.sizeOffscreen(tab)
  }

  /**
   * The slot changed size. An embedded page follows its <webview> on its own; only an offscreen tab's fixed
   * emulated size and native view are updated here.
   */
  private async rescale(tab: Tab): Promise<void> {
    if (tab.view === null || !tab.ready || this.currentView.mode === 'fit') return
    const view = this.effectiveView()
    const sameSize = tab.applied !== undefined && tab.applied !== null && tab.applied.width === view.width && tab.applied.height === view.height
    if (sameSize) return
    tab.applied = { ...view }
    this.sizeOffscreen(tab)
    const command = emulationCommands(view, this.engine, { bounds: this.slotRect(), scale: 1 }).find((c) => c.method === 'Emulation.setDeviceMetricsOverride')
    if (command === undefined) return
    await tab.cdp.send(command.method, command.params).catch(() => undefined)
  }

  /** An offscreen tab's native view is the size its page lays out at; it is never added to a window. */
  private sizeOffscreen(tab: Tab): void {
    if (tab.view === null) return
    const view = tab.applied ?? this.effectiveView()
    const slot = this.slotRect()
    const size =
      view.mode === 'fit' || view.width <= 0 || view.height <= 0
        ? { width: slot.width > 0 ? slot.width : 1280, height: slot.height > 0 ? slot.height : 800 }
        : { width: view.width, height: view.height }
    try {
      tab.view.setBounds({ x: 0, y: 0, ...size })
    } catch {
      // The view is already gone.
    }
  }

  private slotRect(): { x: number; y: number; width: number; height: number } {
    return { x: this.bounds.x, y: this.bounds.y, width: this.bounds.width, height: this.bounds.height }
  }

  /** Page CSS px to view px for CDP input: 1, since the engine no longer draws pages scaled (applyEmulation). */
  private drawScale(tab: Tab): number {
    return tab.scale
  }

  /** Screenshot px to view px. Screenshots are taken at the emulated size, so this is the draw scale. */
  private shotScale(tab: Tab): number {
    return this.drawScale(tab)
  }

  private zoomOf(tab: Tab): number {
    try {
      return tab.wc.getZoomFactor()
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
    const wc = tab.wc
    tab.status = null
    tab.loadError = null
    try {
      // A load that never finishes (a hidden page that stalled, a site that streams for ever) is read as it stands.
      await withDeadline(wc.loadURL(url), 45_000, 'The page load')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (tab.loadError === null && !/ERR_ABORTED/.test(message) && !(error instanceof PageTimeout)) tab.loadError = message
    }
    await this.settle(300)
    let page = await this.readText(tab)
    // Single-page apps often paint their text a while after load (x.com takes a few seconds): give them up to
    // eight before calling the page empty, so a slow site is never mistaken for one refusing this browser.
    for (let waited = 0; page.text.trim().length < 25 && tab.loadError === null && waited < 8_000; waited += 500) {
      await this.settle(500)
      page = await this.readText(tab)
    }
    return { status: tab.status, error: tab.loadError, title: page.title, text: page.text }
  }

  private async readText(tab: Tab): Promise<{ title: string; text: string }> {
    try {
      const raw = objectOf(await this.run(tab, pageTextScript(), 8_000))
      return { title: typeof raw['title'] === 'string' ? raw['title'] : '', text: typeof raw['text'] === 'string' ? raw['text'] : '' }
    } catch {
      return { title: safeTitle(tab.wc), text: '' }
    }
  }

  private async applySiteFixes(tab: Tab): Promise<void> {
    const wc = tab.wc
    const url = safeUrl(tab.wc)
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
      await withDeadline(wc.executeJavaScript(`(async () => { try { ${js}\n } catch (e) { console.warn('site fix failed', e); } })()`, true) as Promise<unknown>, 10_000).catch(() => undefined)
    }
  }

  private async clearSiteData(tab: Tab, url: string): Promise<number> {
    const session = tab.wc.session
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
    const tab = this.activeTab()
    if (tab !== null) this.lastGesture.set(tab.id, Date.now())
    try {
      return await action()
    } finally {
      this.injectingInput = false
    }
  }

  setAgentDriving(on: boolean, reason = ''): void {
    // Done, carry on (or Give back) while a guide runs: he says he is finished, so the guide ends as done.
    if (on) this.guiding.endAll('person')
    // Off: the person takes the tab in question: the asking agent's own when it hands over, else the one in front
    // of them (whatever profile it is in; the person's own profile is only where their NEW tabs open).
    const asking = currentOwner() !== undefined
    this.personTab = on ? null : ((asking ? (this.activeTab() ?? this.shownTab()) : this.shownTab())?.id ?? null)
    // The person taking a tab over by hand (no agent asked) makes it his; a handoff stays the agent's tab.
    if (!on && !asking && this.personTab !== null) this.runTabs.givenToPerson(this.personTab)
    this.handoffReason = on ? '' : reason
    // A handoff opens the page full size so the person can sign in or pass a check comfortably;
    // handing back puts it in the panel again.
    if (!on && reason !== '' && this.hasPage()) this.expanded = true
    if (on) this.expanded = false
    for (const tab of this.tabs) void this.refreshInputGuard(tab)
    this.emit()
  }

  // ---- tabs and the window ----------------------------------------------------------------

  /** Which tab each agent drives ("main", "routine", "helper:<id>"): never shared between them. */
  private readonly ownerTabs = new Map<string, string>()
  /** Which profile's sign-ins each agent browses with, so one helper switching profile never moves another. */
  private readonly ownerPartitions = new Map<string, string>()
  /** Google accounts last read per partition (googleAccounts). */
  private readonly googleSeen = new Map<string, { at: number; emails: string[] }>()

  /** The partition the agent acting right now browses in. */
  private partitionNow(): string {
    const owner = currentOwner()
    return owner === undefined ? this.current : (this.ownerPartitions.get(owner) ?? this.partition)
  }

  private activeTab(): Tab | null {
    const owner = currentOwner()
    if (owner !== undefined) {
      const id = this.ownerTabs.get(owner)
      const tab = id === undefined ? undefined : this.tabs.find((item) => item.id === id)
      // An agent that has not opened a page of its own has none: it never borrows another agent's tab, and a
      // tab from another profile's sign-ins is not reused either (the next open makes one in the right profile).
      // A tab the person handed over is the one exception: it keeps the sign-ins it was handed over with.
      const usable = tab !== undefined && (tab.partition === this.partitionNow() || this.handedTabs.has(tab.id)) ? tab : null
      // Browsing again: its run is live, so its tabs are not due to close (the main agent's next turn).
      this.runTabs.used(owner)
      if (usable !== null) this.wakeTab(usable)
      return usable
    }
    return pickTab(this.tabs, this.activeId, this.current)
  }

  /**
   * The view a tab opens a site in. What the agent learned by itself (a site that loaded empty, so it tried a
   * phone) is for the agent's own tabs; the person's tab presents this computer as it really is unless they chose
   * a view for that site by hand. An emulated phone on a PC is exactly what sign-in risk checks refuse.
   */
  private viewForTab(url: string, tab: Tab): ViewSpec {
    if (tab.id === this.personTab && this.sites.get(url)?.pinned !== true) return this.sites.defaultView()
    return this.sites.viewFor(url)
  }

  /**
   * The person's one tap when a site misbehaves (a sign-in that fails, a page that will not load): drop everything
   * learned or forced for the site (view, user agent, headers, scripts, CSS), clear its caches and service workers
   * (its sign-ins stay), present this computer's own browser and reload. The agent's browser_fix forget plus
   * clear_data in one step, without signing them out.
   */
  async fixSite(): Promise<string> {
    const tab = this.shownTab()
    if (tab === null || !isRealPage(tab.wc)) return 'No page is open.'
    const url = safeUrl(tab.wc)
    const site = siteOf(url)
    if (site === null) return 'This page is not a website.'
    for (const key of tab.siteCss.splice(0)) await tab.wc.removeInsertedCSS(key).catch(() => undefined)
    this.sites.forget(url)
    try {
      await tab.wc.session.clearStorageData({ origin: new URL(url).origin, storages: ['serviceworkers', 'cachestorage', 'shadercache'] })
    } catch {
      // Nothing cached to clear.
    }
    const base = this.sites.defaultView()
    this.currentView = base.mode === 'phone' || base.mode === 'tablet' ? presetView('desktop') : { ...base, userAgent: '' }
    for (const each of this.tabs) await this.applyEmulation(each)
    this.layout()
    tab.wc.reload()
    await this.waitForLoad(tab, 10_000)
    this.emit()
    return `Fixed ${site}: forgot what was learned for it, cleared its caches and opened it again as this computer's own browser.`
  }

  /** The tab in front of the person, whichever partition it is in. */
  private shownTab(): Tab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? this.tabs[0] ?? null
  }

  /** The person's browser profile: the partition the tabs they open use. */
  personPartition(): string {
    return this.current
  }

  /** The person switches browser profile, as in Chrome: their next tab opens with its sign-ins. Remembered. */
  usePersonPartition(partition: string): void {
    const next = partition.trim() === '' ? this.partition : partition
    this.sites.setPerson(next)
    if (next === this.current) return
    this.current = next
    this.emit()
  }

  /**
   * Which Google accounts a profile is signed in to, from Google's own ListAccounts (what Chrome's account menu
   * reads). A profile with no Google sign-in cookie is not asked at all. Cached briefly per profile.
   */
  async googleAccounts(partition: string): Promise<string[]> {
    const cached = this.googleSeen.get(partition)
    if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.emails
    const session = electronSession.fromPartition(partition)
    let emails: string[] = []
    try {
      const signedIn = await session.cookies.get({ domain: 'google.com', name: 'SID' })
      if (signedIn.length > 0) {
        const answer = await session.fetch('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', {
          method: 'POST',
          credentials: 'include',
          signal: AbortSignal.timeout(5_000),
        })
        if (answer.ok) emails = emailsIn(await answer.text()).slice(0, 10)
      }
    } catch {
      // Offline or Google changed its answer: the menu shows the profile without accounts.
    }
    this.googleSeen.set(partition, { at: Date.now(), emails })
    return emails
  }

  /**
   * Learned apps: whether a profile's browser holds site data for an address, read from the session itself:
   * cookies that would be sent to it, or the site's own IndexedDB (sites like chat apps keep their sign-in
   * there, not in cookies). Never reads a value, only whether something is there.
   */
  async hasSiteData(partition: string, url: string): Promise<boolean> {
    let origin: URL
    try {
      origin = new URL(url)
    } catch {
      return false
    }
    const session = electronSession.fromPartition(partition)
    try {
      if ((await session.cookies.get({ url: origin.origin })).length > 0) return true
    } catch {
      // A session that cannot list its cookies is checked by its stored data below.
    }
    const dir = session.getStoragePath()
    if (dir === null || dir === undefined) return false
    const key = `${origin.protocol.replace(':', '')}_${origin.hostname}_${origin.port === '' ? '0' : origin.port}`
    try {
      return statSync(join(dir, 'IndexedDB', `${key}.indexeddb.leveldb`)).isDirectory()
    } catch {
      return false
    }
  }

  /** Signs a browser profile out of everything: its cookies, storage and caches go, and its open tabs reload. */
  async signOutPartition(partition: string): Promise<void> {
    const session = electronSession.fromPartition(partition)
    await session.clearStorageData().catch(() => undefined)
    await session.clearCache().catch(() => undefined)
    this.googleSeen.delete(partition)
    for (const tab of this.tabs) {
      if (tab.partition !== partition) continue
      try {
        tab.wc.reload()
      } catch {
        // A tab closing as this runs has nothing to reload.
      }
    }
    this.emit()
  }

  /**
   * Learned apps: one tab per site (see BrowserDriver.useSiteTab and site-tab.ts). The acting agent drives the tab
   * already on the site in its partition; other agents that drove a duplicate are moved onto it and the duplicate
   * is closed, so a one-session site (WhatsApp Web) never kicks itself off. The person's tab is never closed.
   */
  useSiteTab(url: string): boolean {
    const partition = this.partitionNow()
    const mine = this.activeTab()
    const plan = siteTabPlan(
      this.tabs.filter((tab) => !tab.wc.isDestroyed()).map((tab) => ({ id: tab.id, partition: tab.partition, url: safeUrl(tab.wc) })),
      url,
      partition,
      mine?.id ?? null,
      this.personTab,
    )
    if (plan === null) return false
    const moved = [...this.ownerTabs].filter(([, tabId]) => plan.close.includes(tabId)).map(([owner]) => owner)
    for (const id of plan.close) this.closeTab(id)
    for (const owner of moved) this.ownerTabs.set(owner, plan.keep)
    // The one tab on the site is shared by every run that uses the learned app: no run's end closes it.
    if (plan.keep !== this.personTab) this.runTabs.shared(plan.keep)
    const owner = currentOwner()
    if (owner !== undefined) this.ownerTabs.set(owner, plan.keep)
    else if (this.activeId !== plan.keep) {
      this.activeId = plan.keep
      this.layout()
      this.emit()
    }
    return true
  }

  /** Profiles: the agent browses in this partition from now on (see BrowserDriver.usePartition). */
  usePartition(partition: string): void {
    const next = partition.trim() === '' ? this.partition : partition
    const owner = currentOwner()
    if (owner !== undefined) {
      // Per agent: this helper's next page opens with this profile's sign-ins; nobody else is moved.
      this.ownerPartitions.set(owner, next)
      return
    }
    if (next === this.current) return
    this.current = next
    const tab = pickTab(this.tabs, this.activeId, next)
    if (tab !== null && tab.id !== this.activeId) {
      this.activeId = tab.id
      this.layout()
    }
    this.emit()
  }

  /**
   * A new tab, in front. The renderer hosts its page in a <webview> inside the card (attachGuest hands it over);
   * when no renderer does so in time (onboarding, the smoke test) the page opens in an offscreen view instead.
   * Null when there are already as many tabs as allowed, or the tab was closed before its page arrived.
   */
  private async createTab(initialUrl?: string, partition: string = this.partitionNow(), openedBy?: string): Promise<Tab | null> {
    // Full: first close what ended runs left behind, so a finished job never blocks a new one.
    if (this.tabs.length + this.pending.size >= this.maxTabs) this.sweepTabs()
    if (this.tabs.length + this.pending.size >= this.maxTabs || this.destroyed) return null
    const id = `tab-${++this.tabSeq}`
    // A popup opens in the view its site needs, with the emulation in place before the first request.
    if (initialUrl !== undefined) this.currentView = this.sites.viewFor(initialUrl)
    const spec = { ...this.currentView }
    this.configureSession(electronSession.fromPartition(partition), partition)
    this.activeId = id
    const owner = currentOwner()
    if (owner !== undefined) this.ownerTabs.set(owner, id)
    // The run that opened it owns it (a tab a page opened belongs to whoever owned that page); the person's own are nobody's.
    const by = owner ?? openedBy
    if (by !== undefined) this.runTabs.opened(id, by)

    const outcome = await this.embedPage(id, partition, spec)
    if (outcome === 'closed' || this.destroyed) return null
    let view: WebContentsView | null = null
    let wc: WebContents
    if (outcome !== null) {
      wc = outcome
    } else {
      view = new WebContentsView({
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      })
      view.setBackgroundColor('#ffffff')
      wc = view.webContents
    }

    const tab: Tab = {
      id,
      partition,
      wc,
      view,
      spec,
      cdp: new Cdp(wc.debugger),
      ready: false,
      applied: null,
      scale: 1,
      status: null,
      loadError: null,
      siteCss: [],
    }
    tab.cdp.guest = view === null
    this.tabs.push(tab)
    this.wireTab(tab)
    if (view !== null) this.sizeOffscreen(tab)
    this.layout()

    if (initialUrl !== undefined) {
      void this.prepare(tab)
        .then(() => tab.wc.loadURL(initialUrl))
        .catch(() => undefined)
    }
    void this.refreshInputGuard(tab)
    this.emit()
    return tab
  }

  /** Shows the renderer the new tab and waits for its <webview> page (see attachGuest). */
  private async embedPage(id: string, partition: string, spec: ViewSpec): Promise<WebContents | null | 'closed'> {
    const win = this.window
    if (win === null || win.isDestroyed()) return null
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), EMBED_WAIT_MS)
      const finish = (outcome: WebContents | null | 'closed'): void => {
        if (this.pending.get(id) !== waiting) return
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(outcome)
      }
      const waiting: PendingTab = { partition, spec, resolve: finish }
      this.pending.set(id, waiting)
      this.emit()
    })
  }

  private wireTab(tab: Tab): void {
    const wc = tab.wc
    wc.setAudioMuted(this.sites.muted())
    // Every listener runs only while the page is alive: a tab closing mid-navigation must never throw (alive.ts).
    wc.on('audio-state-changed', whileAlive(wc, 'tab audio', () => this.emit()))

    const guard = whileAlive(wc, 'tab navigation guard', (event: Electron.Event, url: string): void => {
      const policy = checkBrowserUrl(url, { personTyped: tab.id === this.personTab })
      if (policy.ok) return
      event.preventDefault()
      this.blockedReason = policy.reason
      this.emit()
    })
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)

    // A click, a tap or a key of the person's is what makes a window.open a window they asked for.
    wc.on(
      'input-event',
      whileAlive(wc, 'tab input', (_event: Electron.Event, input: Electron.InputEvent) => {
        const types = ['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'gestureTap']
        if (types.includes(input.type)) this.lastGesture.set(tab.id, Date.now())
      }),
    )

    const persons = tab.id === this.personTab
    wc.setWindowOpenHandler((details) => {
      const policy = checkBrowserUrl(details.url, { personTyped: persons })
      if (!policy.ok) {
        this.blockedReason = policy.reason
        this.emit()
        return { action: 'deny' }
      }
      const plan = planWindowOpen({
        url: policy.url,
        disposition: details.disposition,
        features: details.features,
        gestureAgeMs: Date.now() - (this.lastGesture.get(tab.id) ?? Number.NEGATIVE_INFINITY),
        tabsOpen: this.tabs.length + this.pending.size,
        maxTabs: this.maxTabs,
        persons,
      })
      if (plan.action === 'popup') {
        // "Continue with Google" (and Facebook's and Apple's buttons) calls window.open from the click itself;
        // the flow ends by posting back to the opener and closing the window. That needs a real window, so it
        // gets one: the tab's own session, its opener kept, and it closes itself when the flow is done.
        if (this.window === null || this.window.isDestroyed()) return { action: 'deny' }
        return { action: 'allow', createWindow: (options) => this.openPopup(tab, options, details.features) }
      }
      if (plan.action === 'same-tab') {
        // The tabs are full: open it right here, as a click would.
        void tab.wc.loadURL(plan.url).catch(() => undefined)
        return { action: 'deny' }
      }
      if (plan.action === 'deny') {
        this.blockedReason = plan.reason
        this.emit()
        return { action: 'deny' }
      }
      // A checked tab in the app; one the person opened is theirs to use.
      void this.createTab(plan.url, tab.partition, persons ? undefined : this.runTabs.ownerOf(tab.id)).then((made) => {
        if (made === null || !persons) return
        this.personTab = made.id
        for (const each of this.tabs) void this.refreshInputGuard(each)
        this.emit()
      })
      return { action: 'deny' }
    })

    wc.on(
      'before-input-event',
      whileAlive(wc, 'tab key', (event: Electron.Event, input: Electron.Input) => {
        const plain = input.type === 'keyDown' && !input.shift && !input.control && !input.alt && !input.meta
        // F11, as in every browser: full screen and back, from inside the page too.
        if (plain && input.key === 'F11') {
          event.preventDefault()
          this.setFullScreen(!(this.fullScreen && this.expanded))
          return
        }
        // Escape leaves full screen first; then it shrinks the full-size page back into the panel, as the bar says.
        if (this.expanded && plain && input.key === 'Escape') {
          event.preventDefault()
          if (this.fullScreen) this.setFullScreen(false)
          else this.setExpanded(false)
          return
        }
        // A key the agent sends itself must still reach the page.
        if (tab.id !== this.personTab && !this.injectingInput) event.preventDefault()
      }),
    )

    // Right-click in a page the person is using: the browser's own short menu, with the hand-over.
    wc.on(
      'context-menu',
      whileAlive(wc, 'tab menu', (_event: Electron.Event, params: Electron.ContextMenuParams) => {
        if (tab.id === this.personTab) this.showPageMenu(tab, params)
      }),
    )

    wc.on(
      'did-navigate',
      whileAlive(wc, 'tab did-navigate', (_event: Electron.Event, _url: string, httpResponseCode: number) => {
        tab.status = httpResponseCode > 0 ? httpResponseCode : null
        // Inserted CSS belongs to the old document; ask for it again on the new one.
        this.inputCss.delete(tab.id)
        tab.siteCss = []
        void this.refreshInputGuard(tab)
        this.emit()
      }),
    )
    wc.on(
      'did-fail-load',
      whileAlive(wc, 'tab did-fail-load', (_event: Electron.Event, errorCode: number, errorDescription: string, _validatedUrl: string, isMainFrame: boolean) => {
        // -3 is an aborted load (a redirect or a newer navigation), not a failure.
        if (isMainFrame && errorCode !== -3) tab.loadError = `net::${errorDescription}`
      }),
    )
    wc.on(
      'did-start-navigation',
      whileAlive(wc, 'tab did-start-navigation', (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
        if (!details.isMainFrame || details.isSameDocument || this.opening) return
        // Following a link to another site: present the way that site needs, as browser_open would.
        const from = siteOf(safeUrl(tab.wc))
        const to = siteOf(details.url)
        if (to === null || to === from) return
        const wanted = this.viewForTab(details.url, tab)
        if (sameView(wanted, this.currentView)) return
        this.currentView = wanted
        void this.applyEmulation(tab)
          .then(() => {
            this.layout()
            this.emit()
          })
          .catch(() => undefined)
      }),
    )
    wc.on(
      'dom-ready',
      whileAlive(wc, 'tab dom-ready', () => {
        void this.applySiteFixes(tab).catch(() => undefined)
      }),
    )
    wc.on('did-navigate-in-page', whileAlive(wc, 'tab in-page', () => this.emit()))
    wc.on('page-title-updated', whileAlive(wc, 'tab title', () => this.emit()))
    wc.on(
      'did-finish-load',
      whileAlive(wc, 'tab did-finish-load', () => {
        void this.refreshInputGuard(tab)
        this.emit()
      }),
    )
    // The page's process went; the page itself may already be gone, so this one does not ask alive().
    wc.on('render-process-gone', () => ifAlive('tab render-process-gone', () => this.emit()))
    // The renderer went away (a reload, a crash) and took the <webview> with it: the tab is gone too.
    wc.on('destroyed', () => ifAlive('tab destroyed', () => this.closeTab(tab.id)))
  }

  /**
   * A window a page opened with window.open: a real child window of the app, so the opener stays intact
   * (window.opener.postMessage, and the form_post that ends Google's sign-in, land back in the tab), it runs in
   * the tab's own session, so the sign-in carries over, and it closes itself when the flow closes it.
   */
  private openPopup(opener: Tab, options: Electron.BrowserWindowConstructorOptions, features: string): WebContents {
    const size = popupSize(features)
    const child = new BrowserWindow({
      ...options,
      parent: this.window ?? undefined,
      width: size.width,
      height: size.height,
      minWidth: 360,
      minHeight: 420,
      center: true,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        ...options.webPreferences,
        // An ordinary page like the tab that opened it: the same sign-ins, the same lockdown.
        partition: opener.partition,
        preload: undefined,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    })
    this.popups.add(child)
    this.popupOpener.set(child, opener.id)
    child.on('closed', () => {
      this.popups.delete(child)
      this.popupOpener.delete(child)
    })
    const wc = child.webContents
    // Still this computer's rules: no local or private address, whatever the page asks for.
    const guard = whileAlive(wc, 'popup navigation guard', (event: Electron.Event, url: string): void => {
      const policy = checkBrowserUrl(url, { personTyped: true })
      if (policy.ok) return
      event.preventDefault()
      this.blockedReason = policy.reason
      this.emit()
    })
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    // A window opened from inside a sign-in window becomes a checked tab, never a second window.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void this.createTab(url, opener.partition, this.runTabs.ownerOf(opener.id))
      return { action: 'deny' }
    })
    // A sign-in window gets the Vault too, as whoever uses the tab that opened it.
    wc.once(
      'dom-ready',
      whileAlive(wc, 'popup dom-ready', () => {
        try {
          if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
          void this.attachVault(wc, () => this.personTab === opener.id)
        } catch {
          // Another tool holds its debugger: no autofill in this window.
        }
      }),
    )
    child.once(
      'ready-to-show',
      whileAlive(child, 'popup show', () => {
        child.show()
        child.focus()
      }),
    )
    return wc
  }

  private configureSession(session: Session, partition: string): void {
    if (this.sessionsReady.has(partition)) return
    this.sessionsReady.add(partition)

    // Chrome's own answers, as far as an app can give them. The powerful permissions are still refused, but
    // the everyday ones are not pre-denied: a page that finds every permission `denied` reads as headless.
    session.setPermissionRequestHandler((_contents, permission, callback) => callback(BENIGN_PERMISSIONS.has(permission)))
    session.setPermissionCheckHandler((_contents, permission) => BENIGN_PERMISSIONS.has(permission))
    // No Electron or app token in the user agent: sites treat those as an embedded shell.
    try {
      // A plain list, the way navigator.languages reads: q-values belong in the header, not in this string.
      session.setUserAgent(userAgentFor(presetView('desktop'), this.engine), languageListFor(this.engine))
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
        if (view !== undefined && view.userAgent !== '') headers['User-Agent'] = userAgentFor(view, this.engine)
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
    // The renderer places every embedded page itself, in the same frame as its card; this only keeps the scale
    // the panel reports, and the size of any offscreen tab.
    this.lastFit = fitView(this.slotRect(), this.effectiveView())
    for (const tab of this.tabs) {
      if (tab.wc.isDestroyed()) continue
      void this.rescale(tab)
    }
  }

  private async refreshInputGuard(tab: Tab): Promise<void> {
    const wc = tab.wc
    if (wc.isDestroyed()) return
    const wanted = (): boolean => tab.id !== this.personTab && (this.lifted.get(tab.id) ?? 0) === 0
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

  /**
   * Runs the browser's own script in the page's isolated world, with a hard deadline: a hidden, starved or frozen
   * page can leave the promise unanswered for ever (measured 25 Oct 2026: 336 s for one open), and the tool waiting
   * on it must end. Rejects with PageTimeout.
   */
  private async run(tab: Tab, code: string, limitMs: number = PAGE_SCRIPT_MS): Promise<unknown> {
    return withDeadline(tab.wc.executeJavaScriptInIsolatedWorld(PAGE_WORLD_ID, [{ code }]) as Promise<unknown>, limitMs)
  }

  private pressKey(tab: Tab, key: string): void {
    const wc = tab.wc
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
    const wc = tab.wc
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
    // The browser view closed (Escape, Done, the tab closed) while full screen: the window comes back with it.
    if (this.fullScreen && !this.expanded) {
      this.fullScreen = false
      this.windowFullScreen(false)
    }
    try {
      this.onState(this.state())
    } catch {
      // A renderer that is closing must not break the browser.
    }
  }

  /** Used by the Electron smoke test: load a data: page and prove the outline helper sees it. */
  async smokeOutline(html: string): Promise<boolean> {
    this.setBounds({ x: 0, y: 0, width: 480, height: 360, visible: true })
    const tab = this.activeTab() ?? (await this.createTab())
    if (tab === null) return false
    try {
      await tab.wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
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

/** What the browser bar says while he is guided. */
function guideLine(n: number, total: number, label: string): string {
  return `Follow the highlight${total > 1 ? ` (step ${n} of ${total})` : ''}: ${label}`
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

function isRealPage(wc: WebContents): boolean {
  const url = safeUrl(wc)
  return url !== '' && url !== 'about:blank'
}

function safeUrl(wc: WebContents): string {
  try {
    return wc.isDestroyed() ? '' : wc.getURL()
  } catch {
    return ''
  }
}

function safeTitle(wc: WebContents): string {
  try {
    return wc.isDestroyed() ? '' : wc.getTitle()
  } catch {
    return ''
  }
}

function safeAudible(wc: WebContents): boolean {
  try {
    return !wc.isDestroyed() && wc.isCurrentlyAudible()
  } catch {
    return false
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

function pageSpecOf(view: ViewSpec): BrowserPageSpec {
  return { mode: view.mode, width: view.width, height: view.height, zoom: view.zoom, fixed: view.fixed === true }
}

/** "tab-12" -> 12, so tabs keep the order they were opened in. */
function tabNumber(id: string): number {
  const n = Number(/(\d+)$/.exec(id)?.[1] ?? '0')
  return Number.isFinite(n) ? n : 0
}

export type { BrowserBounds, BrowserState }

/** Where a new tab the person opens starts. */
export const NEW_TAB_PAGE = 'https://www.google.com/'

/** What the person typed in the address bar, as an address to open. Plain words become a Google search. */
export function addressOf(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return null
  if (/^https?:\/\//i.test(text)) return text
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text) || /^localhost(:\d+)?(\/\S*)?$/i.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}

