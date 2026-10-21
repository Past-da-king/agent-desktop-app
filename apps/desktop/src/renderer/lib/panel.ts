/**
 * The chat panel's browser plumbing: width memory, the drag limits, and the rectangle we report to
 * the main process. The live page is a native view painted over the renderer, so the only thing that
 * places it is this measurement.
 */
import type { BrowserBounds } from '@agent/core'

export const PANEL_MIN_WIDTH = 320
export const PANEL_MAX_WIDTH = 560
export const PANEL_DEFAULT_WIDTH = 380
export const PANEL_PREF_KEY = 'agent.browser.panel'

export interface PanelPrefs {
  width: number
  collapsed: boolean
}

export function clampPanelWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PANEL_DEFAULT_WIDTH
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(value)))
}

type PrefStore = Pick<Storage, 'getItem' | 'setItem'>

export function readPanelPrefs(store?: Pick<Storage, 'getItem'> | null): PanelPrefs {
  const fallback: PanelPrefs = { width: PANEL_DEFAULT_WIDTH, collapsed: false }
  if (!store) return fallback
  try {
    const raw = store.getItem(PANEL_PREF_KEY)
    if (raw === null || raw === '') return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback
    const record = parsed as Record<string, unknown>
    return { width: clampPanelWidth(record['width']), collapsed: record['collapsed'] === true }
  } catch {
    return fallback
  }
}

export function writePanelPrefs(prefs: PanelPrefs, store?: PrefStore | null): void {
  if (!store) return
  const clean: PanelPrefs = { width: clampPanelWidth(prefs.width), collapsed: prefs.collapsed === true }
  try {
    store.setItem(PANEL_PREF_KEY, JSON.stringify(clean))
  } catch {
    // Private mode and locked-down browsers refuse storage. The panel still works for this run.
  }
}

/** A DOM rectangle (CSS pixels, viewport relative) as the main process wants it. */
export function boundsFor(
  rect: { left: number; top: number; width: number; height: number },
  visible: boolean,
): BrowserBounds {
  const round = (value: number): number => (Number.isFinite(value) ? Math.round(value) : 0)
  const width = Math.max(0, round(rect.width))
  const height = Math.max(0, round(rect.height))
  return {
    x: round(rect.left),
    y: round(rect.top),
    width,
    height,
    visible: visible === true && width > 0 && height > 0,
  }
}

/** "skyhop.example/flights" for the read-only URL bar. */
export function displayUrl(url: string): string {
  return url.trim().replace(/^https?:\/\//i, '')
}

/** The browser card folds to one line when the person minimized it, or when nothing is open and they did not open it. */
export function browserTucked(mode: 'auto' | 'min' | 'open', hasPage: boolean): boolean {
  return mode === 'min' || (mode === 'auto' && !hasPage)
}

/** What opening the folded card means: follow the pages from now on, or show the empty card on purpose. */
export function openedMode(hasPage: boolean): 'auto' | 'open' {
  return hasPage ? 'auto' : 'open'
}
