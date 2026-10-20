/**
 * The slice of the browser the tools use. `AgentBrowser` implements it for real; tests pass a small
 * fake, so tool behaviour can be checked without Electron.
 */

export interface BrowserDriver {
  /** Navigate the active tab and return the page outline as text. */
  open(url: string): Promise<string>
  /** The current page outline, re-read from the live page. */
  snapshot(): Promise<string>
  /** Read a numbered element, a CSS selector, or the whole page. */
  read(target?: { index?: number; selector?: string }): Promise<string>
  click(index: number): Promise<string>
  type(index: number, text: string, submit: boolean): Promise<string>
  press(key: string): Promise<string>
  scroll(dy: number): Promise<string>
  waitFor(query: { text: string; selector: string }, seconds: number, signal?: AbortSignal): Promise<string>
  back(): Promise<string>
  /** Saves a PNG and returns its absolute path, or null. */
  screenshot(): Promise<string | null>
  upload(index: number, path: string): Promise<string>
  /** While the agent drives, the page ignores the person's mouse and keyboard. */
  setAgentDriving(on: boolean, reason?: string): void
  hasPage(): boolean
}

/** Stands in until the window exists, and in tests that do not care about the browser. */
export const unavailableBrowser: BrowserDriver = {
  async open() {
    return 'The browser is not open right now.'
  },
  async snapshot() {
    return 'No page is open yet. Use browser_open with a web address.'
  },
  async read() {
    return 'No page is open yet. Use browser_open with a web address.'
  },
  async click() {
    return 'No page is open yet. Use browser_open with a web address.'
  },
  async type() {
    return 'No page is open yet. Use browser_open with a web address.'
  },
  async press() {
    return 'No page is open yet. Use browser_open with a web address.'
  },
  async scroll() {
    return 'No page is open yet. Use browser_open with a web address.'
  },
  async waitFor() {
    return 'No page is open yet. Use browser_open with a web address.'
  },
  async back() {
    return 'No page is open yet. Use browser_open with a web address.'
  },
  async screenshot() {
    return null
  },
  async upload() {
    return 'No page is open yet. Use browser_open with a web address.'
  },
  setAgentDriving() {
    return undefined
  },
  hasPage() {
    return false
  },
}

// ---- the stronger controls: emulation, fixes per site, snapshot by role and name, trusted input ----

export interface ViewRequest {
  mode?: 'desktop' | 'tablet' | 'phone' | 'fit'
  width?: number
  height?: number
  /** "16:9", "9:16", "4:3" */
  aspect?: string
  dpr?: number
  zoom?: number
  touch?: boolean
  userAgent?: string
  /** Back to the default view (and forget this site's view). */
  reset?: boolean
  /** Also use this view for sites the browser has not learned yet. */
  asDefault?: boolean
  /** Remember this view for the current site. Default true. */
  remember?: boolean
}

export type FixAction = 'css' | 'js' | 'clear_data' | 'headers' | 'user_agent' | 'retry' | 'forget' | 'list'

export interface FixRequest {
  action: FixAction
  css?: string
  js?: string
  headers?: Record<string, string>
  userAgent?: string
  /** Keep it for every later visit to the site. Default true. */
  persist?: boolean
}

export type ActAction =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'type'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'hover'
  | 'focus'
  | 'press'
  | 'hold'
  | 'drag'
  | 'scroll'

export interface ActRequest {
  action: ActAction
  index?: number
  name?: string
  role?: string
  nth?: number
  text?: string
  submit?: boolean
  key?: string
  /** Page coordinates in screenshot pixels, for canvases and cross-origin frames. */
  at?: { x: number; y: number }
  to?: { x: number; y: number }
  ms?: number
  dy?: number
}

export interface BrowserProDriver {
  view(request: ViewRequest): Promise<string>
  fix(request: FixRequest): Promise<string>
  snapshotPro(options: { filter?: string; deep?: boolean }): Promise<string>
  act(request: ActRequest): Promise<string>
  evaluate(code: string, seconds: number, signal?: AbortSignal): Promise<string>
}

export function isBrowserPro(value: unknown): value is BrowserProDriver {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Record<keyof BrowserProDriver, unknown>>
  return (
    typeof candidate.view === 'function' &&
    typeof candidate.fix === 'function' &&
    typeof candidate.snapshotPro === 'function' &&
    typeof candidate.act === 'function' &&
    typeof candidate.evaluate === 'function'
  )
}

const NOT_OPEN = 'The browser is not open right now.'

export const unavailableBrowserPro: BrowserProDriver = {
  async view() {
    return NOT_OPEN
  },
  async fix() {
    return NOT_OPEN
  },
  async snapshotPro() {
    return NOT_OPEN
  },
  async act() {
    return NOT_OPEN
  },
  async evaluate() {
    return NOT_OPEN
  },
}
