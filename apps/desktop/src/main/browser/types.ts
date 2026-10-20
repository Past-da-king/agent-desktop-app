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
