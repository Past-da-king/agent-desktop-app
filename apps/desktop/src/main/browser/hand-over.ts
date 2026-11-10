/**
 * Hand a page to the agent, the main process's half (10 Nov 2026). shared/hand-over.ts decides what is handed over;
 * this writes it where the message box can carry it: a note (address, title, tab id, the selected text) and a
 * picture of the visible page, both ordinary attachments in the app's attachments folder. A page that cannot be
 * pictured is still handed over, and the note says why there is no picture.
 *
 * Also here: the page's right-click menu, as plain data, so the menu and the toolbar button always say the same.
 */
import type { Attachment, BrowserHandOver } from '@agent/core'

import { HAND_OVER_NOTE_SUFFIX, buildHandOver, canHandOver, handOverLabel } from '../../shared/hand-over'
import { savePastedFile } from '../pasted'

export interface HandOverSource {
  tabId: string
  url: string
  title: string
  /** What the person had selected, or a way to ask the page for it. A page that does not answer has none. */
  selection: string | null | (() => Promise<string>)
  /** A PNG of the visible page, or null when it could not be drawn. May throw. */
  capture: () => Promise<Uint8Array | null>
}

/** How long the page gets to say what is selected before it is handed over without it. */
export const HAND_OVER_SELECTION_MS = 1_500

async function selectionOf(source: HandOverSource): Promise<string> {
  if (typeof source.selection !== 'function') return source.selection ?? ''
  try {
    return await Promise.race([source.selection(), new Promise<string>((resolve) => setTimeout(() => resolve(''), HAND_OVER_SELECTION_MS))])
  } catch {
    return ''
  }
}

/**
 * Builds the hand-over for a page and writes its files under `root`. Null when there is no real page (an empty
 * tab, one of the browser's own pages). Never throws: whatever fails is said in `problem`.
 */
export async function makeHandOver(root: string, source: HandOverSource, now = new Date()): Promise<BrowserHandOver | null> {
  if (!canHandOver(source.url)) return null
  const selection = await selectionOf(source)
  let png: Uint8Array | null = null
  let captureProblem = ''
  try {
    png = await source.capture()
    if (png !== null && png.byteLength === 0) png = null
    if (png === null) captureProblem = 'The page could not be drawn just now; it may be busy or still loading.'
  } catch {
    png = null
    captureProblem = 'The page did not answer when its picture was taken.'
  }

  const attachments: Attachment[] = []
  let picture: Attachment | null = null
  const first = buildHandOver({ tabId: source.tabId, url: source.url, title: source.title, selection, captured: png !== null, captureProblem })
  if (first === null) return null
  if (png !== null) {
    try {
      picture = savePastedFile(root, `${first.name}.png`, 'image/png', png, now)
    } catch {
      picture = null
      captureProblem = 'The picture of the page could not be saved.'
    }
  }
  // The note says truthfully whether a picture came with it, so it is built once the picture is on disk.
  const payload = picture !== null ? first : (buildHandOver({ tabId: source.tabId, url: source.url, title: source.title, selection, captured: false, captureProblem }) ?? first)
  try {
    attachments.push(savePastedFile(root, `${payload.name}${HAND_OVER_NOTE_SUFFIX}`, 'text/markdown', Buffer.from(payload.note, 'utf8'), now))
  } catch {
    // No note could be written: nothing reliable to hand over.
    return null
  }
  if (picture !== null) attachments.push(picture)
  return { tabId: payload.tabId, url: payload.url, title: payload.title, selection: payload.selection, attachments, problem: payload.problem }
}

export type PageMenuItem = { id: 'back' | 'reload' | 'copy' | 'paste' | 'hand-over'; label: string; enabled: boolean } | { id: 'separator' }

export interface PageMenuFacts {
  agentName: string
  url: string
  canGoBack: boolean
  hasSelection: boolean
  editable: boolean
}

/** The page's right-click menu: the few things a browser always offers, then the hand-over. */
export function pageMenuItems(facts: PageMenuFacts): PageMenuItem[] {
  const items: PageMenuItem[] = [
    { id: 'back', label: 'Back', enabled: facts.canGoBack },
    { id: 'reload', label: 'Reload', enabled: true },
  ]
  if (facts.hasSelection || facts.editable) {
    items.push({ id: 'separator' })
    if (facts.hasSelection) items.push({ id: 'copy', label: 'Copy', enabled: true })
    if (facts.editable) items.push({ id: 'paste', label: 'Paste', enabled: true })
  }
  items.push({ id: 'separator' }, { id: 'hand-over', label: handOverLabel(facts.agentName), enabled: canHandOver(facts.url) })
  return items
}
