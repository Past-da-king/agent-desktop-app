/**
 * What the agent's browser has learned about each site, and how it opens a site the way that works.
 *
 * Ported from the phone's browser (SiteHealth.kt, SiteAdapt.kt, SiteCatalog.kt): a site nobody has
 * told us about opens in the agent's chosen default view; the loaded page is read for the signs of a
 * refusal (an "unsupported browser" message, an HTTP block, an empty page); when presenting as the
 * other kind of browser could plausibly help, that is tried once, and whatever got through is
 * remembered for the next visit. On top of the phone's version, a site can carry fixes the agent made
 * on the fly: CSS and JavaScript applied on every visit, extra request headers and its own user agent.
 *
 * Stored as one small JSON file under userData. Nothing here knows about any particular site.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { isViewMode, presetView, resolveView, type ViewMode, type ViewSpec } from './emulation'

export interface SiteProfile {
  /** The view that last got through, or that the agent pinned. */
  view?: ViewSpec
  /** 'works' or 'refused' (in every view tried). */
  outcome?: 'works' | 'refused'
  reason?: string
  /** CSS inserted into every page of the site. */
  css?: string[]
  /** JavaScript run in every page of the site once it has loaded. */
  js?: string[]
  /** Extra request headers for the site. */
  headers?: Record<string, string>
  /** True when the agent set the view by hand: adaptation then leaves it alone. */
  pinned?: boolean
  at: number
}

interface SiteFile {
  version: 1
  defaultView: ViewSpec
  sites: Record<string, SiteProfile>
}

const MAX_SITES = 300
const MAX_FIXES = 12
const MAX_FIX_LENGTH = 20_000

/** The site: its host without a leading www. or m. Subdomains are learned on their own. */
export function siteOf(url: string): string | null {
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '')
    return host === '' ? null : host
  } catch {
    return null
  }
}

export class SiteStore {
  private data: SiteFile
  private readonly file: string | null
  private readonly now: () => number

  constructor(file: string | null, now: () => number = Date.now) {
    this.file = file
    this.now = now
    this.data = { version: 1, defaultView: presetView('desktop'), sites: {} }
    this.load()
  }

  defaultView(): ViewSpec {
    return { ...this.data.defaultView }
  }

  setDefaultView(view: ViewSpec): void {
    this.data.defaultView = { ...view }
    this.save()
  }

  get(url: string): SiteProfile | null {
    const site = siteOf(url)
    if (site === null) return null
    const profile = this.data.sites[site]
    return profile === undefined ? null : cloneProfile(profile)
  }

  /** The view to open a site in: what was learned for it, else the default. */
  viewFor(url: string): ViewSpec {
    const profile = this.get(url)
    if (profile?.view !== undefined && profile.outcome !== 'refused') return { ...profile.view }
    return this.defaultView()
  }

  update(url: string, change: (profile: SiteProfile) => void): SiteProfile | null {
    const site = siteOf(url)
    if (site === null) return null
    const profile = cloneProfile(this.data.sites[site] ?? { at: this.now() })
    change(profile)
    profile.at = this.now()
    this.data.sites[site] = profile
    this.trim()
    this.save()
    return cloneProfile(profile)
  }

  record(url: string, view: ViewSpec, outcome: 'works' | 'refused', reason = ''): void {
    this.update(url, (profile) => {
      profile.view = { ...view }
      profile.outcome = outcome
      profile.reason = reason.slice(0, 200)
    })
  }

  addCss(url: string, css: string): SiteProfile | null {
    return this.update(url, (profile) => {
      profile.css = pushLimited(profile.css ?? [], css.slice(0, MAX_FIX_LENGTH))
    })
  }

  addJs(url: string, js: string): SiteProfile | null {
    return this.update(url, (profile) => {
      profile.js = pushLimited(profile.js ?? [], js.slice(0, MAX_FIX_LENGTH))
    })
  }

  setHeaders(url: string, headers: Record<string, string>): SiteProfile | null {
    return this.update(url, (profile) => {
      const next = { ...(profile.headers ?? {}) }
      for (const [name, value] of Object.entries(headers)) {
        if (value === '') delete next[name]
        else next[name] = value
      }
      profile.headers = next
    })
  }

  forget(url: string): boolean {
    const site = siteOf(url)
    if (site === null || this.data.sites[site] === undefined) return false
    delete this.data.sites[site]
    this.save()
    return true
  }

  /** Headers for a request to this URL, or null when the site has none. */
  headersFor(url: string): Record<string, string> | null {
    const profile = this.get(url)
    if (profile?.headers === undefined || Object.keys(profile.headers).length === 0) return null
    return profile.headers
  }

  list(): Array<{ site: string; profile: SiteProfile }> {
    return Object.entries(this.data.sites)
      .map(([site, profile]) => ({ site, profile: cloneProfile(profile) }))
      .sort((a, b) => b.profile.at - a.profile.at)
  }

  private trim(): void {
    const entries = Object.entries(this.data.sites)
    if (entries.length <= MAX_SITES) return
    entries.sort((a, b) => a[1].at - b[1].at)
    for (const [site] of entries.slice(0, entries.length - MAX_SITES)) delete this.data.sites[site]
  }

  private load(): void {
    if (this.file === null) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return
      const raw = parsed as Record<string, unknown>
      const defaultView = viewFrom(raw['defaultView'])
      const sites: Record<string, SiteProfile> = {}
      const rawSites = raw['sites']
      if (typeof rawSites === 'object' && rawSites !== null) {
        for (const [site, value] of Object.entries(rawSites as Record<string, unknown>)) {
          const profile = profileFrom(value)
          if (profile !== null) sites[site] = profile
        }
      }
      this.data = { version: 1, defaultView: defaultView ?? presetView('desktop'), sites }
    } catch {
      // No file yet, or a damaged one: start fresh rather than refuse to browse.
    }
  }

  private save(): void {
    if (this.file === null) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, JSON.stringify(this.data, null, 2))
      renameSync(temp, this.file)
    } catch {
      // Learning is a bonus; a full disk must not break the browser.
    }
  }
}

function pushLimited(list: string[], value: string): string[] {
  const next = list.filter((item) => item !== value)
  next.push(value)
  return next.slice(-MAX_FIXES)
}

function cloneProfile(profile: SiteProfile): SiteProfile {
  return JSON.parse(JSON.stringify(profile)) as SiteProfile
}

function viewFrom(value: unknown): ViewSpec | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const mode = raw['mode']
  if (!isViewMode(mode)) return null
  const num = (key: string): number | undefined => (typeof raw[key] === 'number' ? (raw[key] as number) : undefined)
  const base = presetView(mode)
  return resolveView(base, {
    ...(num('width') === undefined ? {} : { width: num('width') }),
    ...(num('height') === undefined ? {} : { height: num('height') }),
    ...(num('dpr') === undefined ? {} : { dpr: num('dpr') }),
    ...(num('zoom') === undefined ? {} : { zoom: num('zoom') }),
    ...(typeof raw['touch'] === 'boolean' ? { touch: raw['touch'] } : {}),
    ...(typeof raw['userAgent'] === 'string' ? { userAgent: raw['userAgent'] } : {}),
  })
}

function profileFrom(value: unknown): SiteProfile | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const strings = (key: string): string[] | undefined =>
    Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((item): item is string => typeof item === 'string') : undefined
  const profile: SiteProfile = { at: typeof raw['at'] === 'number' ? raw['at'] : 0 }
  const view = viewFrom(raw['view'])
  if (view !== null) profile.view = view
  if (raw['outcome'] === 'works' || raw['outcome'] === 'refused') profile.outcome = raw['outcome']
  if (typeof raw['reason'] === 'string') profile.reason = raw['reason']
  const css = strings('css')
  if (css !== undefined) profile.css = css
  // Scripts used to be kept by default, so probes the agent wrote to look around ended up running on every visit.
  // One that pins its own box over the page is such a leftover, never a fix: it is dropped as the profile loads.
  const js = strings('js')?.filter((script) => !isLeftoverProbe(script))
  if (js !== undefined && js.length > 0) profile.js = js
  if (typeof raw['headers'] === 'object' && raw['headers'] !== null) {
    const headers: Record<string, string> = {}
    for (const [name, header] of Object.entries(raw['headers'] as Record<string, unknown>)) {
      if (typeof header === 'string') headers[name] = header
    }
    profile.headers = headers
  }
  if (raw['pinned'] === true) profile.pinned = true
  return profile
}

// ---- reading a page for a refusal (SiteHealth.kt) --------------------------------------------------

export type Refusal =
  | 'none'
  | 'unsupported_browser'
  | 'http_blocked'
  | 'human_check'
  | 'signin_refused'
  | 'blank'
  | 'load_error'

export const REFUSAL_LABEL: Record<Refusal, string> = {
  none: 'loaded fine',
  unsupported_browser: "the site says this browser or device isn't supported",
  http_blocked: 'the site answered with a block (HTTP error)',
  human_check: 'the site wants proof of a human (captcha or browser check)',
  signin_refused: 'the site refused to sign in inside this browser',
  blank: 'the page loaded empty, which usually means its scripts gave up on this browser',
  load_error: "the page didn't load (network or certificate error)",
}

export interface Verdict {
  refusal: Refusal
  evidence: string
}

/** Presenting as a different kind of browser can plausibly change this. A captcha or sign-in refusal will not. */
export function identityMayHelp(verdict: Verdict): boolean {
  return verdict.refusal === 'unsupported_browser' || verdict.refusal === 'http_blocked' || verdict.refusal === 'blank'
}

const UNSUPPORTED =
  /(browser|device|platform)\s+(is\s+)?(not|isn.t)\s+(supported|compatible)|unsupported\s+(browser|device)|(use|try|switch to)\s+(a|an|another|the|our)?\s*(different|supported|desktop|modern|newer)?\s*(browser|computer|desktop)|upgrade your browser|update your browser|(only|best)\s+(available|works|viewed)\s+(on|in)\s+(a\s+)?(desktop|computer|chrome|laptop)|not\s+(available|supported)\s+on\s+(mobile|phones?)|open\s+(this\s+)?(page\s+)?(in|on)\s+(a\s+)?(desktop|computer)|please\s+use\s+(a\s+)?(desktop|computer|laptop)|(mobile|phone)\s+(browsers?\s+)?(is|are)\s+not\s+supported|(from|on|using|in)\s+(a\s+)?(web\s+)?(browser\s+)?on\s+your\s+(computer|desktop|laptop|pc)|(from|on|using)\s+(your|a)\s+(computer|desktop|laptop|pc)\b/i
const HUMAN =
  /verify (that )?you are (a )?human|are you a (robot|human)|captcha|unusual traffic|checking your browser|just a moment|press (and|&) hold|performing security verification|security check to access/i
const SIGNIN = /disallowed_useragent|may not be secure|Couldn.t sign you in|isn.t secure|browser or app may not be secure/i
const NET_ERROR = /net::ERR_[A-Z_]+/
const BLOCKED_WORDS = /access denied|request blocked|you have been blocked|error 1020|forbidden|not authori[sz]ed to view/i

/** `status` is the main page's HTTP status if known, `error` a load error, `text` the visible text. */
export function assessPage(status: number | null, error: string | null, title: string, text: string): Verdict {
  const t = text.trim()
  const net = NET_ERROR.exec(t)?.[0] ?? (error === null ? null : NET_ERROR.exec(error)?.[0] ?? null)
  if (net !== null && net !== 'net::ERR_ABORTED') {
    return net.includes('HTTP_RESPONSE_CODE_FAILURE')
      ? { refusal: 'http_blocked', evidence: `the site answered with an HTTP error and no page (${net})` }
      : { refusal: 'load_error', evidence: net }
  }
  if (error !== null && error !== '' && status === null && t.length < 60) return { refusal: 'load_error', evidence: error.slice(0, 160) }
  let match = SIGNIN.exec(t)
  if (match !== null) return { refusal: 'signin_refused', evidence: snippet(t, match.index, match[0].length) }
  match = HUMAN.exec(`${title}\n${t}`)
  if (match !== null && (t.length < 1500 || status === 403 || status === 429 || status === 503)) {
    const at = Math.max(0, match.index - title.length - 1)
    return { refusal: 'human_check', evidence: snippet(t, at, match[0].length) }
  }
  match = UNSUPPORTED.exec(t)
  // A wall of text that mentions "unsupported browser" among a lot of content is a footer, not a refusal.
  if (match !== null && t.length < 1200) return { refusal: 'unsupported_browser', evidence: snippet(t, match.index, match[0].length) }
  if (status !== null && [403, 406, 429, 451, 503].includes(status) && t.length < 1500) {
    const words = BLOCKED_WORDS.exec(t)
    return { refusal: 'http_blocked', evidence: `HTTP ${status}${words === null ? '' : `: ${snippet(t, words.index, words[0].length)}`}` }
  }
  match = BLOCKED_WORDS.exec(t)
  if (match !== null && t.length < 400) return { refusal: 'http_blocked', evidence: snippet(t, match.index, match[0].length) }
  if (status !== null && status >= 500 && t.length < 200) return { refusal: 'load_error', evidence: `HTTP ${status}` }
  if (t.length < 25 && (status === null || status < 400)) return { refusal: 'blank', evidence: 'no visible text' }
  return { refusal: 'none', evidence: '' }
}

function snippet(text: string, at: number, length: number): string {
  return text
    .slice(Math.max(0, at - 40), Math.min(text.length, at + length + 60))
    .replace(/\s+/g, ' ')
    .trim()
}

// ---- opening a site the way that works (SiteAdapt.kt) ----------------------------------------------

/** What the adaptive opener needs from a browser; AgentBrowser implements it, tests fake it. */
export interface SitePort {
  currentView(): ViewSpec
  applyView(view: ViewSpec): Promise<void>
  /** Load the URL and report what came back. */
  load(url: string): Promise<{ status: number | null; error: string | null; title: string; text: string }>
}

export interface Opened {
  verdict: Verdict
  view: ViewSpec
  /** Told to the agent ahead of the page. */
  notes: string
  triedBoth: boolean
}

function modeName(mode: ViewMode): string {
  return mode === 'fit' ? 'panel-sized desktop' : mode
}

/** Desktop and fit fall back to phone; phone and tablet fall back to desktop. */
export function otherView(view: ViewSpec): ViewSpec {
  return view.mode === 'phone' || view.mode === 'tablet' ? presetView('desktop') : presetView('phone')
}

export async function openAdaptive(port: SitePort, store: SiteStore, url: string, asked: ViewSpec | null): Promise<Opened> {
  const known = store.get(url)
  const start = asked ?? store.viewFor(url)
  await port.applyView(start)
  const firstPage = await port.load(url)
  const first = assessPage(firstPage.status, firstPage.error, firstPage.title, firstPage.text)
  if (first.refusal === 'none') {
    if (known === null || known.outcome !== 'works' || known.view?.mode !== start.mode) store.record(url, start, 'works')
    const remembered = asked === null && known?.outcome === 'works' && known.view !== undefined
      ? `Known site: opened as a ${modeName(start.mode)} browser (learned earlier).\n`
      : ''
    return { verdict: first, view: start, notes: remembered, triedBoth: false }
  }
  if (asked !== null || known?.pinned === true || !identityMayHelp(first)) {
    if (!identityMayHelp(first)) store.record(url, start, 'refused', REFUSAL_LABEL[first.refusal])
    return { verdict: first, view: start, notes: diagnosis(first, [modeName(start.mode)]), triedBoth: false }
  }
  const second = otherView(start)
  await port.applyView(second)
  const secondPage = await port.load(url)
  const retry = assessPage(secondPage.status, secondPage.error, secondPage.title, secondPage.text)
  if (retry.refusal === 'none') {
    store.record(url, second, 'works', `as a ${modeName(start.mode)} browser: ${REFUSAL_LABEL[first.refusal]}`)
    return {
      verdict: retry,
      view: second,
      notes: `The site refused a ${modeName(start.mode)} browser (${REFUSAL_LABEL[first.refusal]}${first.evidence === '' ? '' : `: ${first.evidence}`}) and worked as a ${modeName(second.mode)} one. Remembered for next time.\n`,
      triedBoth: true,
    }
  }
  // Neither worked: go back to the view it started in, and say so.
  await port.applyView(start)
  store.record(url, start, 'refused', `${REFUSAL_LABEL[first.refusal]}; also refused as a ${modeName(second.mode)} browser`)
  return { verdict: first, view: start, notes: diagnosis(first, [modeName(start.mode), modeName(second.mode)]), triedBoth: true }
}

/** What to do next. Kept in one place so every tool that hits a refusal teaches the same thing. */
export function diagnosis(verdict: Verdict, tried: string[]): string {
  const lines: string[] = []
  const evidence = verdict.evidence === '' ? '' : ` ("${verdict.evidence}")`
  lines.push(`THE SITE REFUSED THIS BROWSER: ${REFUSAL_LABEL[verdict.refusal]}${evidence}. Tried: ${tried.join(' and ')}.`)
  lines.push('Next, in this order:')
  if (verdict.refusal === 'human_check') {
    lines.push('1. This needs a person: browser_handoff, let the user pass the check, then carry on in the same session.')
  } else if (verdict.refusal === 'signin_refused') {
    lines.push("1. Use the site's email or password sign-in instead of its single sign-on button, or browser_handoff so the user signs in.")
  } else {
    lines.push('1. Look at it: browser_look for the pixels, browser_eval to read what the page actually holds.')
    lines.push('2. Fix it on the fly: browser_view for another device or size, browser_fix to clear the site\'s data, send a header or a different user agent, or hide what is in the way.')
  }
  lines.push("3. Otherwise tell the user plainly what the site refuses and what the options are. Don't retry the same thing.")
  return `${lines.join('\n')}\n`
}

/** A kept script that adds a fixed-position element of its own over the page: a debugging probe, not a fix. */
export function isLeftoverProbe(script: string): boolean {
  return /createElement\s*\(/.test(script) && /position\s*:\s*fixed/i.test(script)
}
