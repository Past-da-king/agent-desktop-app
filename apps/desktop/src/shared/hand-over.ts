/**
 * Hand a page to the agent (10 Nov 2026): the reverse of browser_handoff. The person presses the button in the
 * browser's toolbar, or picks the same line in the page's right-click menu, and the page in front of them lands in
 * the message box as context: its address, its title, the text they had selected, a picture of what was on screen
 * and the id of the tab, so the agent can be told to carry on in that very tab.
 *
 * This file is the one place that decides what is handed over. Pure: no Electron, no files. The main process
 * (main/browser/hand-over.ts) writes the note and the picture to disk and sends both as ordinary attachments.
 */

/** Selected text beyond this is cut, and the note says so. */
export const HAND_OVER_SELECTION_MAX = 8_000

/** A note handed over from the browser ends in this, so the message box can show it as a page, not a text file. */
export const HAND_OVER_NOTE_SUFFIX = '.page.md'

export interface HandOverInput {
  /** The tab's id in the app's browser ("tab-3"): how the agent tells which tab it is. */
  tabId: string
  url: string
  title: string
  /** What the person had selected on the page, if anything. */
  selection?: string | null
  /** The picture of the visible page was taken. */
  captured: boolean
  /** Why there is no picture, in plain words, when there is none. */
  captureProblem?: string
}

export interface HandOverPayload {
  tabId: string
  url: string
  title: string
  /** Trimmed and capped; '' when nothing was selected. */
  selection: string
  /** The selection was longer than the cap and was cut. */
  selectionCut: boolean
  hasScreenshot: boolean
  /** '' when the picture was taken, else why it was not. */
  problem: string
  /** A safe base name for the files (no extension), from the title or the site. */
  name: string
  /** The note the agent reads: what was handed over and how to act on it. */
  note: string
}

/** The button and the menu line, with the name the person gave their agent. */
export function handOverLabel(agentName: string): string {
  const name = agentName.trim()
  return `Hand to ${name === '' ? 'your agent' : name}`
}

/** Only real web pages are handed over: not an empty tab, not the browser's own pages. */
export function canHandOver(url: string): boolean {
  return /^https?:\/\/[^/\s]+/i.test(url.trim())
}

function siteOf(url: string): string {
  const match = /^https?:\/\/([^/?#\s]+)/i.exec(url.trim())
  return match === null ? '' : (match[1] ?? '').replace(/^www\./i, '')
}

/** A file name every system takes, short enough to read on a chip. */
export function handOverName(title: string, url: string): string {
  const base = (title.trim() === '' ? siteOf(url) : title)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  const short = base.length > 60 ? base.slice(0, 60).trim() : base
  return short === '' ? 'Page' : short
}

/**
 * What is handed over for this page, or null when there is no real page to hand over. A page that could not be
 * pictured is still handed over, with its address and text, and the note says why there is no picture.
 */
export function buildHandOver(input: HandOverInput): HandOverPayload | null {
  const url = input.url.trim()
  const tabId = input.tabId.trim()
  if (tabId === '' || !canHandOver(url)) return null
  const title = input.title.replace(/\s+/g, ' ').trim()
  const whole = (input.selection ?? '').replace(/\r\n?/g, '\n').trim()
  const selectionCut = whole.length > HAND_OVER_SELECTION_MAX
  const selection = selectionCut ? whole.slice(0, HAND_OVER_SELECTION_MAX).trimEnd() : whole
  const hasScreenshot = input.captured === true
  const problem = hasScreenshot ? '' : (input.captureProblem ?? '').trim() || 'The page could not be pictured.'
  const name = handOverName(title, url)

  const lines = [
    '# Page handed over from the browser',
    '',
    "The person handed you this page from the app's browser. They may ask about it, or tell you to take over this tab.",
    '',
    `- Title: ${title === '' ? '(no title)' : title}`,
    `- Address: ${url}`,
    `- Tab: ${tabId}`,
    hasScreenshot ? '- Picture: attached with this message, the page as it was on their screen' : `- Picture: none. ${problem}`,
    '',
    `To carry on in this very tab, call browser_open with tab "${tabId}" (no url needed). The tab stays the person's until you do, and they can take it back at any time.`,
  ]
  if (selection !== '') {
    lines.push('', `## Text they selected${selectionCut ? ` (the first ${HAND_OVER_SELECTION_MAX} characters)` : ''}`, '', selection)
  }
  return { tabId, url, title, selection, selectionCut, hasScreenshot, problem, name, note: `${lines.join('\n')}\n` }
}

/** Whether an attachment is a page handed over from the browser (the note, by its name). */
export function isHandedPage(name: string): boolean {
  return name.toLowerCase().endsWith(HAND_OVER_NOTE_SUFFIX)
}

/** The page's name as the chip shows it: the note's file name without its ending. */
export function handedPageTitle(name: string): string {
  return isHandedPage(name) ? name.slice(0, name.length - HAND_OVER_NOTE_SUFFIX.length) : name
}
