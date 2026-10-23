/**
 * A page's own windows: the ones it opens with `window.open`, which is how Google, Facebook and Apple sign-in
 * finish on almost every site. An app that refuses them has no sign-in behind those buttons at all, so this file
 * holds the one rule that decides what each window.open becomes. Pure: no Electron, so it is tested on its own.
 */

/** How long a click, tap or key counts as the gesture behind a window.open (Chromium's own transient activation). */
export const GESTURE_MS = 5_000

/**
 * - `popup`: a real window of its own, opener kept (window.opener.postMessage and the form_post that ends a
 *   sign-in land back in the tab), for window.open with window features or a request Chromium marks as a popup;
 * - `tab`: a checked tab in the app, for a link that asked for a new tab;
 * - `same-tab`: the tabs are full, so the person's own click opens right here in front of them;
 * - `deny`: a script with no click behind it, or no room left for an agent's window.
 */
export type WindowOpenPlan =
  | { action: 'popup' }
  | { action: 'tab'; url: string }
  | { action: 'same-tab'; url: string }
  | { action: 'deny'; reason: string }

/** What the browser knows when a page asks for a window. */
export interface WindowOpenRequest {
  /** The address the page asked for, already through url-policy. */
  url: string
  /** Electron's HandlerDetails.disposition: how the window was asked for. */
  disposition: string
  /** Electron's HandlerDetails.features: the size and switches the page asked for. */
  features: string
  /** How long ago the person last clicked, tapped or typed in this tab. Infinity when they never have. */
  gestureAgeMs: number
  /** Tabs open, plus the ones still waiting for their page. */
  tabsOpen: number
  maxTabs: number
  /** True when this tab is the person's own, so their click may open over the tab limit. */
  persons: boolean
}

export function planWindowOpen(request: WindowOpenRequest): WindowOpenPlan {
  // Nothing a script does on its own gets a window: a click, a tap or a key has to be behind it.
  if (!(request.gestureAgeMs <= GESTURE_MS)) {
    return { action: 'deny', reason: 'A page tried to open a window without a click.' }
  }
  if (isPopupWindow(request.disposition, request.features)) return { action: 'popup' }
  if (request.tabsOpen < request.maxTabs) return { action: 'tab', url: request.url }
  // The tabs are full: the person's own click still opens, right here.
  if (request.persons) return { action: 'same-tab', url: request.url }
  return { action: 'deny', reason: `There are already ${request.maxTabs} browser tabs open.` }
}

/** True when the page asked for a window of its own rather than a tab (window.open with width or height does). */
export function isPopupWindow(disposition: string, features: string): boolean {
  if (disposition === 'new-window') return true
  return /(?:^|,)\s*(?:width|height)\s*=/i.test(features)
}

/** The size the page asked for, kept within what a sign-in window can actually be used at. */
export function popupSize(features: string): { width: number; height: number } {
  const width = readNumber(features, 'width') ?? 500
  const height = readNumber(features, 'height') ?? 700
  return { width: clamp(width, 360, 1200), height: clamp(height, 420, 1000) }
}

function readNumber(features: string, name: string): number | null {
  const match = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(\\d+)`, 'i').exec(features)
  if (match === null) return null
  const value = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(value) ? value : null
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
