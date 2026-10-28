/**
 * The headless node's own browser: a Chromium the machine already has (Playwright's, or chromium / google-chrome on
 * the PATH, or AGENT_CHROMIUM_PATH), run headless and driven over the Chrome DevTools Protocol. It reuses the desktop
 * browser's page scripts (outline, snapshot, read, type, eval) and its trusted CDP input, so the agent gets the same
 * tools with the same answers. Each agent (main, routine, every helper) gets its own tab. Chromium starts on first use
 * and is closed after a quiet spell, so an idle server holds no browser in memory.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Script } from 'node:vm'

import { Cdp, type DebuggerLike } from '../main/browser/cdp'
import { PageTimeout, WAIT_MAX_S, waitAnswer, withDeadline } from '../main/browser/deadline'
import { currentOwner } from '../main/browser/owner'
import { onRunEnded } from '../main/browser/run-tabs'
import {
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
} from '../main/browser/outline'
import {
  evalWrapper,
  formatSnapshot,
  looksLikeExpression,
  pageTextScript,
  parseResolved,
  parseSnapshot,
  resolveScript,
  snapshotScript,
} from '../main/browser/snapshot'
import { formatUpload, uploadFiles, type UploadHost, type UploadTarget } from '../main/browser/upload'
import type { ActRequest, BrowserDriver, BrowserProDriver, FixRequest, ViewRequest } from '../main/browser/types'
import type { BrowserVault } from '../main/vault/browser-vault'

const NO_PAGE = 'No page is open yet. Use browser_open with a web address.'
const MAX_TABS = 6

/** The newest usable Chromium on this machine, or null. */
export function findChromium(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const chosen = env['AGENT_CHROMIUM_PATH']?.trim() ?? ''
  if (chosen !== '') return existsSync(chosen) ? chosen : null
  const cache = env['PLAYWRIGHT_BROWSERS_PATH']?.trim() || join(home, '.cache', 'ms-playwright')
  const candidates: string[] = []
  try {
    const dirs = readdirSync(cache).sort((a, b) => revision(b) - revision(a))
    // The headless shell is lighter; a full Chromium works too.
    for (const dir of dirs.filter((d) => d.startsWith('chromium_headless_shell-'))) {
      candidates.push(join(cache, dir, 'chrome-linux', 'headless_shell'), join(cache, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'))
    }
    for (const dir of dirs.filter((d) => /^chromium-\d+$/.test(d))) {
      candidates.push(join(cache, dir, 'chrome-linux', 'chrome'), join(cache, dir, 'chrome-linux64', 'chrome'))
    }
  } catch {
    // No Playwright cache here.
  }
  // A system Chromium (Debian and Ubuntu keep the real binary here). Always started with our own profile folder and
  // its own debugging port, never attached to a browser something else already runs.
  candidates.push('/usr/lib/chromium/chromium', '/usr/lib/chromium-browser/chromium-browser')
  for (const dir of (env['PATH'] ?? '').split(':')) {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) candidates.push(join(dir, name))
  }
  return candidates.find((file) => existsSync(file)) ?? null
}

function revision(dir: string): number {
  const match = /-(\d+)$/.exec(dir)
  return match === null ? 0 : Number(match[1])
}

/** One CDP connection to one tab, over the WebSocket Node has built in. */
class TabSocket implements DebuggerLike {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  private open = false

  private constructor(private readonly ws: WebSocket) {}

  static connect(url: string): Promise<TabSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const tab = new TabSocket(ws)
      ws.addEventListener('open', () => {
        tab.open = true
        resolve(tab)
      })
      ws.addEventListener('error', () => reject(new Error('Could not reach the browser tab.')))
      ws.addEventListener('close', () => {
        tab.open = false
        for (const { reject: fail } of tab.pending.values()) fail(new Error('The browser tab closed.'))
        tab.pending.clear()
      })
      ws.addEventListener('message', (event) => tab.onMessage(String(event.data)))
    })
  }

  private onMessage(text: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown> }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const waiter = this.pending.get(message.id)
      if (waiter === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'CDP error'))
      else waiter.resolve(message.result)
      return
    }
    if (typeof message.method === 'string') {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {})
      for (const listener of this.anyListeners) listener(message.method, message.params ?? {})
    }
  }

  readonly anyListeners = new Set<(method: string, params: Record<string, unknown>) => void>()

  isAttached(): boolean {
    return this.open
  }

  attach(): void {
    if (!this.open) throw new Error('The browser tab is closed.')
  }

  detach(): void {
    this.ws.close()
  }

  sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.open) return Promise.reject(new Error('The browser tab is closed.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  once(method: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const set = this.listeners.get(method) ?? new Set()
      this.listeners.set(method, set)
      const done = (params: Record<string, unknown> | null): void => {
        clearTimeout(timer)
        set.delete(listener)
        resolve(params)
      }
      const listener = (params: Record<string, unknown>): void => done(params)
      const timer = setTimeout(() => done(null), timeoutMs)
      set.add(listener)
    })
  }
}

interface Tab {
  id: string
  socket: TabSocket
  cdp: Cdp
  url: string
}

export interface HeadlessBrowserOptions {
  /** Profile folders live here, one per partition. */
  dir: string
  executable: string
  /** Close Chromium after this long without a browser tool call. */
  idleMs?: number
  log?: (message: string, detail?: Record<string, string | number>) => void
}

export class HeadlessBrowser implements BrowserDriver, BrowserProDriver {
  private proc: ChildProcess | null = null
  private port = 0
  private starting: Promise<void> | null = null
  private readonly tabs = new Map<string, Tab>()
  private partition = 'default'
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly idleMs: number
  private styles: string[] = []
  private vault: BrowserVault | null = null

  /** The Vault in every tab from now on: agents' passkeys (after the person's yes) and sign-ins. */
  setVault(vault: BrowserVault): void {
    this.vault = vault
  }

  /** Runs that ended, waiting out their grace before their tab closes (run-tabs.ts). */
  private readonly ending = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly offRunEnd: () => void

  constructor(private readonly options: HeadlessBrowserOptions) {
    this.idleMs = options.idleMs ?? 10 * 60_000
    // A run that ends closes its tab: a helper's or a routine's at once, the main agent's after a few idle minutes.
    this.offRunEnd = onRunEnded((owner, graceMs) => this.endRun(owner, graceMs))
  }

  /** A run ended: its tab closes after `graceMs`, unless it browses again first. */
  endRun(owner: string, graceMs = 0): void {
    const waiting = this.ending.get(owner)
    if (waiting !== undefined) clearTimeout(waiting)
    this.ending.delete(owner)
    if (!this.tabs.has(owner)) return
    if (graceMs === 0) {
      void this.closeTab(owner)
      return
    }
    const timer = setTimeout(() => {
      this.ending.delete(owner)
      void this.closeTab(owner)
    }, graceMs)
    timer.unref?.()
    this.ending.set(owner, timer)
  }

  /** Stop listening for runs (the node is shutting down). */
  dispose(): void {
    this.offRunEnd()
    for (const timer of this.ending.values()) clearTimeout(timer)
    this.ending.clear()
  }

  /** browser_close: the acting agent closes its tab (here every agent has one). */
  async closeOwnTab(id?: string): Promise<string> {
    const owner = currentOwner() ?? 'main'
    const tab = this.tabs.get(owner)
    if (tab === undefined) return 'You have no tab open.'
    if (id !== undefined && id.trim() !== '' && id.trim() !== tab.id) return `${id.trim()} is not your tab. Yours is ${tab.id}.`
    await this.closeTab(owner)
    return `Closed ${tab.id}. You have no tabs open now.`
  }

  // ---- the process and its tabs ----

  private touch(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.close('idle'), this.idleMs)
    this.idleTimer.unref()
  }

  private async ensureBrowser(): Promise<void> {
    if (this.proc !== null && this.proc.exitCode === null && this.port > 0) return
    this.starting ??= this.launch().finally(() => {
      this.starting = null
    })
    await this.starting
  }

  private async launch(): Promise<void> {
    const profile = join(this.options.dir, this.partition.replace(/[^A-Za-z0-9_-]/g, '_') || 'default')
    mkdirSync(profile, { recursive: true, mode: 0o700 })
    // The sandbox first; some servers forbid the user namespaces it needs, then without it (the page still runs in
    // its own process, and this user owns everything it can reach anyway).
    for (const sandbox of [true, false]) {
      const args = [
        '--headless=new',
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1440,900',
        ...(sandbox ? [] : ['--no-sandbox']),
        'about:blank',
      ]
      const proc = spawn(this.options.executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      const port = await new Promise<number>((resolve) => {
        let text = ''
        const timer = setTimeout(() => resolve(0), 20_000)
        proc.stderr?.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8')
          const match = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(text)
          if (match !== null) {
            clearTimeout(timer)
            resolve(Number(match[1]))
          }
        })
        proc.once('exit', () => {
          clearTimeout(timer)
          resolve(0)
        })
      })
      if (port > 0) {
        this.proc = proc
        this.port = port
        proc.stderr?.resume()
        proc.once('exit', () => {
          if (this.proc === proc) {
            this.proc = null
            this.port = 0
            this.tabs.clear()
          }
        })
        this.options.log?.('Browser started', { sandbox: sandbox ? 1 : 0 })
        return
      }
      proc.kill('SIGKILL')
    }
    throw new Error('The browser on this machine would not start.')
  }

  private async devtools(path: string, method = 'GET'): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, { method })
    const text = await res.text()
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  /** The calling agent's own tab, made on first use. */
  private async tab(create: boolean): Promise<Tab | null> {
    const owner = currentOwner() ?? 'main'
    // Browsing again: the run is live, so its tab is not due to close.
    const ending = this.ending.get(owner)
    if (ending !== undefined) {
      clearTimeout(ending)
      this.ending.delete(owner)
    }
    const existing = this.tabs.get(owner)
    if (existing !== undefined && existing.socket.isAttached()) return existing
    if (!create) return null
    await this.ensureBrowser()
    if (this.tabs.size >= MAX_TABS) {
      const [oldest] = this.tabs.keys()
      if (oldest !== undefined) await this.closeTab(oldest)
    }
    const target = (await this.devtools('/json/new?about:blank', 'PUT')) as { id?: string; webSocketDebuggerUrl?: string }
    if (typeof target.webSocketDebuggerUrl !== 'string' || typeof target.id !== 'string') throw new Error('The browser did not open a tab.')
    const socket = await TabSocket.connect(target.webSocketDebuggerUrl)
    const cdp = new Cdp(socket, 20_000)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    for (const css of this.styles) await this.injectStyle(cdp, css)
    if (this.vault !== null) {
      // No person at a server's browser: only agents use it, so a passkey needs the person's yes (vault_passkey).
      await this.vault
        .attach(
          {
            send: (method, params) => socket.sendCommand(method, params ?? {}),
            onEvent: (listener) => {
              socket.anyListeners.add(listener)
              return () => socket.anyListeners.delete(listener)
            },
          },
          { person: () => false },
        )
        .catch(() => undefined)
    }
    const tab: Tab = { id: target.id, socket, cdp, url: '' }
    this.tabs.set(owner, tab)
    return tab
  }

  private async closeTab(owner: string): Promise<void> {
    const tab = this.tabs.get(owner)
    if (tab === undefined) return
    this.tabs.delete(owner)
    tab.socket.detach()
    await this.devtools(`/json/close/${tab.id}`).catch(() => undefined)
  }

  async close(reason = 'stop'): Promise<void> {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
    for (const owner of [...this.tabs.keys()]) this.tabs.get(owner)?.socket.detach()
    this.tabs.clear()
    const proc = this.proc
    this.proc = null
    this.port = 0
    if (proc !== null && proc.exitCode === null) {
      proc.kill('SIGTERM')
      this.options.log?.('Browser closed', { reason })
    }
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  // ---- running page scripts ----

  private async run(tab: Tab, expression: string, timeoutMs = 20_000): Promise<unknown> {
    const reply = (await withDeadline(
      tab.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }),
      timeoutMs,
    )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
    if (reply.exceptionDetails !== undefined) {
      throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'The page script failed.')
    }
    return reply.result?.value
  }

  private async outline(tab: Tab): Promise<string> {
    return formatOutline(parseOutline(await this.run(tab, outlineScript())))
  }

  private async withTab(create: boolean, work: (tab: Tab) => Promise<string>): Promise<string> {
    this.touch()
    try {
      const tab = await this.tab(create)
      if (tab === null) return NO_PAGE
      return await work(tab)
    } catch (error) {
      return `The browser could not do that: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async navigate(tab: Tab, url: string): Promise<string | null> {
    const loaded = tab.socket.once('Page.loadEventFired', 30_000)
    const result = (await tab.cdp.send('Page.navigate', { url })) as { errorText?: string }
    if (typeof result.errorText === 'string' && result.errorText !== '') return result.errorText
    await loaded
    tab.url = url
    return null
  }

  // ---- BrowserDriver ----

  hasPage(): boolean {
    const owner = currentOwner() ?? 'main'
    return this.tabs.get(owner)?.socket.isAttached() === true
  }

  currentUrl(): string {
    return this.tabs.get(currentOwner() ?? 'main')?.url ?? ''
  }

  usePartition(partition: string): void {
    if (partition === this.partition) return
    this.partition = partition
    // Another profile means other sign-ins: its own Chromium profile folder, started on the next call.
    void this.close('profile')
  }

  setAgentDriving(): void {
    // Nobody else uses this browser: there is no person's mouse to hold off.
  }

  open(url: string): Promise<string> {
    return this.withTab(true, async (tab) => {
      const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
      if (!/^(https?|about|data):/i.test(target)) return 'Only web addresses (https://...) open here.'
      const failed = await this.navigate(tab, target)
      if (failed !== null) return `The page did not load: ${failed}`
      return this.outline(tab)
    })
  }

  snapshot(): Promise<string> {
    return this.withTab(false, (tab) => this.outline(tab))
  }

  read(target: { index?: number; selector?: string } = {}): Promise<string> {
    return this.withTab(false, async (tab) => {
      const result = parseRead(await this.run(tab, readScript(target)))
      return result.ok ? `${result.label}:\n${result.text}` : result.reason
    })
  }

  click(index: number): Promise<string> {
    return this.withTab(false, async (tab) => {
      const result = parseAction(await this.run(tab, clickScript(index)))
      if (!result.ok) return result.reason
      await new Promise((r) => setTimeout(r, 600))
      return `Clicked ${result.label}.\n\n${await this.outline(tab)}`
    })
  }

  type(index: number, text: string, submit: boolean): Promise<string> {
    return this.withTab(false, async (tab) => {
      const result = parseAction(await this.run(tab, typeScript(index, text)))
      if (!result.ok) return result.reason
      if (submit) {
        await tab.cdp.press('Enter')
        await new Promise((r) => setTimeout(r, 1000))
      }
      return `Typed into ${result.label}.\n\n${await this.outline(tab)}`
    })
  }

  press(key: string): Promise<string> {
    return this.withTab(false, async (tab) => {
      if (!(await tab.cdp.press(key))) return `I do not know the key ${key}.`
      await new Promise((r) => setTimeout(r, 400))
      return `Pressed ${key}.\n\n${await this.outline(tab)}`
    })
  }

  scroll(dy: number): Promise<string> {
    return this.withTab(false, async (tab) => {
      await this.run(tab, scrollScript(dy))
      return this.outline(tab)
    })
  }

  waitFor(query: { text: string; selector: string }, seconds: number): Promise<string> {
    return this.withTab(false, async (tab) => {
      const limit = Math.max(1, Math.min(WAIT_MAX_S, Math.floor(seconds)))
      let found = false
      let reason = ''
      let timedOut = false
      try {
        const result = parseAction(await this.run(tab, waitForScript(query.text, query.selector, limit * 1000), limit * 1000 + 2_000))
        found = result.ok
        reason = result.ok ? '' : result.reason
      } catch (error) {
        if (!(error instanceof PageTimeout)) throw error
        timedOut = true
      }
      // Always ends at its limit and says what the page showed (it used to answer an empty line on a miss).
      const seen = await this.run(tab, pageTextScript(), 3_000).then(
        (raw) => {
          const page = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
          return { url: tab.url, title: typeof page['title'] === 'string' ? page['title'] : '', text: typeof page['text'] === 'string' ? page['text'] : '' }
        },
        () => null,
      )
      const answer = waitAnswer({ found, reason, timedOut }, query, limit, seen)
      if (reason !== '') return answer
      const outline = await this.outline(tab).catch(() => '')
      return outline === '' ? answer : `${answer}\n\n${outline}`
    })
  }

  back(): Promise<string> {
    return this.withTab(false, async (tab) => {
      const loaded = tab.socket.once('Page.loadEventFired', 15_000)
      await this.run(tab, 'history.back(); true')
      await loaded
      return this.outline(tab)
    })
  }

  private shotProblem = ''

  screenshotProblem(): string {
    return this.shotProblem
  }

  async screenshot(): Promise<string | null> {
    this.touch()
    const tab = await this.tab(false).catch(() => null)
    if (tab === null) {
      this.shotProblem = NO_PAGE
      return null
    }
    this.shotProblem = ''
    const shot = (await withDeadline(tab.cdp.send('Page.captureScreenshot', { format: 'png' }), 15_000, 'The page capture').catch((error: unknown) => {
      this.shotProblem = error instanceof Error ? error.message : String(error)
      return {}
    })) as { data?: string }
    if (typeof shot.data !== 'string') {
      if (this.shotProblem === '') this.shotProblem = 'the page could not be drawn'
      return null
    }
    this.shotProblem = ''
    const dir = join(this.options.dir, '..', 'screenshots')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `shot-${Date.now()}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    return file
  }

  upload(target: UploadTarget, paths: string[]): Promise<string> {
    return this.withTab(false, async (tab) => {
      const host: UploadHost = {
        link: {
          send: (method, params = {}) => tab.cdp.send(method, params),
          onEvent: (listener) => {
            const each = (method: string, params: Record<string, unknown>): void => listener(method, params)
            tab.socket.anyListeners.add(each)
            return () => tab.socket.anyListeners.delete(each)
          },
        },
        runPage: (code) => this.run(tab, code),
        click: async (at) => {
          await tab.cdp.click(at, 1)
          return true
        },
      }
      const outcome = await uploadFiles(host, target, paths)
      return formatUpload(outcome)
    })
  }

  async evaluateRaw(code: string, timeoutMs = 30_000): Promise<unknown> {
    this.touch()
    const tab = await this.tab(false)
    if (tab === null) throw new Error(NO_PAGE)
    return this.run(tab, code, timeoutMs)
  }

  // ---- BrowserProDriver ----

  snapshotPro(options: { filter?: string; deep?: boolean }): Promise<string> {
    return this.withTab(false, async (tab) =>
      formatSnapshot(parseSnapshot(await this.run(tab, snapshotScript(options))), options.filter === undefined ? {} : { filter: options.filter }),
    )
  }

  evaluate(code: string, seconds: number): Promise<string> {
    return this.withTab(false, async (tab) => {
      const limit = Math.max(1, Math.min(120, seconds)) * 1000
      let raw: Record<string, unknown>
      try {
        const value = await this.run(tab, evalWrapper(code, looksLikeExpression(code, compiles)), limit)
        raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
      } catch (error) {
        if (error instanceof Error && error.message === 'timeout') {
          return `Still running after ${Math.round(limit / 1000)} s; it carries on in the page. Poll window.__agentLog with another browser_eval.`
        }
        throw error
      }
      const log = Array.isArray(raw['log']) ? (raw['log'] as unknown[]).map(String) : []
      const lines = raw['ok'] === true
        ? [`Result: ${raw['value'] === undefined ? '(no value returned)' : JSON.stringify(raw['value'], null, 1).slice(0, 8000)}`]
        : [`The script failed: ${String(raw['error'] ?? 'unknown error')}`]
      if (log.length > 0) lines.push('', 'Log:', ...log.slice(-80))
      return lines.join('\n')
    })
  }

  act(request: ActRequest): Promise<string> {
    return this.withTab(false, async (tab) => {
      const cdp = tab.cdp
      if (request.action === 'press') {
        return (await cdp.press(request.key ?? 'Enter')) ? `Pressed ${request.key ?? 'Enter'}.` : `I do not know the key ${request.key ?? ''}.`
      }
      if (request.action === 'scroll' && request.at === undefined && request.index === undefined && request.name === undefined) {
        await this.run(tab, scrollScript(request.dy ?? 600))
        return 'Scrolled.'
      }
      let at = request.at
      let label = 'that spot'
      if (at === undefined) {
        const query = {
          ...(request.index === undefined ? {} : { index: request.index }),
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.role === undefined ? {} : { role: request.role }),
          ...(request.nth === undefined ? {} : { nth: request.nth }),
        }
        const resolved = parseResolved(await this.run(tab, resolveScript(query)))
        if (!resolved.ok) return resolved.reason
        at = { x: resolved.x, y: resolved.y }
        label = resolved.label || resolved.tag
      }
      switch (request.action) {
        case 'click':
        case 'check':
        case 'uncheck':
          await cdp.click(at, 1)
          break
        case 'double_click':
          await cdp.click(at, 1, { clickCount: 2 })
          break
        case 'right_click':
          await cdp.click(at, 1, { button: 'right' })
          break
        case 'hover':
          await cdp.hover(at, 1)
          break
        case 'hold':
          await cdp.hold(at, 1, request.ms ?? 1500)
          break
        case 'drag':
          if (request.to === undefined) return 'Say where to drag to (to_x, to_y).'
          await cdp.drag(at, request.to, 1)
          break
        case 'scroll':
          await cdp.wheel(at, 1, request.dy ?? 600)
          break
        case 'focus':
          await cdp.click(at, 1)
          break
        case 'type':
          await cdp.click(at, 1)
          await cdp.press('ctrl+a')
          await cdp.press('Backspace')
          await cdp.insertText(request.text ?? '')
          if (request.submit === true) await cdp.press('Enter')
          break
        case 'select': {
          // A native <select>: the option chosen by its text, through the page.
          const option = JSON.stringify(request.text ?? '')
          const ok = await this.run(tab, `(() => { const el = document.activeElement && document.activeElement.tagName === 'SELECT' ? document.activeElement : document.elementFromPoint(${at.x}, ${at.y}); if (!el || el.tagName !== 'SELECT') return false; const o = Array.from(el.options).find((x) => x.textContent.trim().toLowerCase().includes(${option}.toLowerCase())); if (!o) return false; el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`)
          if (ok !== true) return 'That option is not in the list.'
          break
        }
        default:
          return `${String(request.action)} is not available in this browser.`
      }
      await new Promise((r) => setTimeout(r, 500))
      return `Done: ${request.action} on ${label}.\n\n${formatSnapshot(parseSnapshot(await this.run(tab, snapshotScript({}))), {})}`
    })
  }

  view(request: ViewRequest): Promise<string> {
    return this.withTab(false, async (tab) => {
      if (request.reset === true || request.mode === 'desktop' || request.mode === 'fit') {
        await tab.cdp.send('Emulation.clearDeviceMetricsOverride')
        await tab.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
        tab.cdp.touch = false
      } else {
        const phone = request.mode === 'phone'
        const width = request.width ?? (phone ? 390 : 820)
        const height = request.height ?? (phone ? 844 : 1180)
        const touch = request.touch ?? true
        await tab.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: request.dpr ?? (phone ? 3 : 2), mobile: phone })
        await tab.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 0 })
        tab.cdp.touch = touch
      }
      if (request.userAgent !== undefined) await tab.cdp.send('Emulation.setUserAgentOverride', { userAgent: request.userAgent })
      await this.run(tab, 'location.reload(); true').catch(() => undefined)
      await tab.socket.once('Page.loadEventFired', 15_000)
      return this.outline(tab)
    })
  }

  fix(request: FixRequest): Promise<string> {
    return this.withTab(false, async (tab) => {
      if (request.action === 'css' && typeof request.css === 'string' && request.css.trim() !== '') {
        this.styles.push(request.css)
        await this.injectStyle(tab.cdp, request.css)
        return 'Added that CSS for this session.'
      }
      if (request.action === 'js' && typeof request.js === 'string') return this.evaluate(request.js, 30)
      if (request.action === 'clear_data') {
        await tab.cdp.send('Network.clearBrowserCookies').catch(() => undefined)
        await this.run(tab, 'try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} location.reload(); true')
        return 'Cleared cookies and storage, and reloaded.'
      }
      if (request.action === 'user_agent' && typeof request.userAgent === 'string') {
        await tab.cdp.send('Emulation.setUserAgentOverride', { userAgent: request.userAgent })
        return 'Using that user agent in this tab.'
      }
      return 'Nothing is remembered per site in this browser yet; css, js, clear_data and user_agent work for this session.'
    })
  }

  private async injectStyle(cdp: Cdp, css: string): Promise<void> {
    const source = `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).appendChild(s); })()`
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })
    await cdp.send('Runtime.evaluate', { expression: source }).catch(() => undefined)
  }
}

function compiles(source: string): boolean {
  try {
    new Script(`(async () => { return (${source}\n); })`)
    return true
  } catch {
    return false
  }
}
