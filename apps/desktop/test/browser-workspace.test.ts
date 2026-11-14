/**
 * The browser as a workspace (10 Nov 2026): in browser view the app's top bar is a slim strip, full screen keeps
 * only the browser's toolbar, and the chat docks beside the page at a width the person drags, folds and gets back
 * after a restart. One pure rule decides the layout (lib/workspace.ts); the dock is remembered per device.
 */
import { describe, expect, it } from 'vitest'

import {
  DOCK_BELOW_WIDTH,
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  DOCK_PAGE_MIN,
  DOCK_PREF_KEY,
  clampDockWidth,
  escapeAction,
  readDockPrefs,
  workspaceLayout,
  writeDockPrefs,
  type WorkspaceInput,
} from '../src/renderer/lib/workspace'
import { createWorkspace } from '../src/renderer/state/useWorkspace'

function fakeStore(initial: Record<string, string> = {}): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) }
}

const base: WorkspaceInput = { expanded: true, hasPage: true, fullScreen: false, dockOpen: true, dockWidth: 400, windowWidth: 1440, tabs: 1 }
const layout = (over: Partial<WorkspaceInput> = {}) => workspaceLayout({ ...base, ...over })

describe('browser view layout', () => {
  it('leaves the app as it is while the page is not open over the window', () => {
    expect(layout({ expanded: false })).toEqual({ view: false, full: false, titleBar: 'normal', dock: 'closed', dockWidth: 0, showTabs: true })
  })

  it('is not a browser view without a page, whatever was asked', () => {
    expect(layout({ hasPage: false, fullScreen: true }).view).toBe(false)
    expect(layout({ hasPage: false, fullScreen: true }).titleBar).toBe('normal')
  })

  it('folds the top bar to a slim strip in browser view and docks the chat beside the page', () => {
    expect(layout()).toEqual({ view: true, full: false, titleBar: 'slim', dock: 'side', dockWidth: 400, showTabs: true })
  })

  it('takes the top bar away in full screen and gives it back after', () => {
    expect(layout({ fullScreen: true }).titleBar).toBe('hidden')
    expect(layout({ fullScreen: true }).full).toBe(true)
    expect(layout({ fullScreen: false }).titleBar).toBe('slim')
    expect(layout({ fullScreen: false }).full).toBe(false)
  })

  it('keeps the tab strip in full screen only when there is more than one tab', () => {
    expect(layout({ fullScreen: true, tabs: 1 }).showTabs).toBe(false)
    expect(layout({ fullScreen: true, tabs: 3 }).showTabs).toBe(true)
    expect(layout({ tabs: 1 }).showTabs).toBe(true)
  })

  it('gives the page the whole width when the chat is folded away', () => {
    expect(layout({ dockOpen: false })).toMatchObject({ dock: 'closed', dockWidth: 0 })
  })

  it('docks the chat under the page on a window too narrow for both', () => {
    expect(layout({ windowWidth: DOCK_BELOW_WIDTH - 1 })).toMatchObject({ dock: 'below', dockWidth: 0 })
    expect(layout({ windowWidth: 390 }).dock).toBe('below')
    expect(layout({ windowWidth: DOCK_BELOW_WIDTH }).dock).toBe('side')
  })

  it('never lets the docked chat squeeze the page under its minimum', () => {
    const fitted = layout({ dockWidth: 700, windowWidth: 900 })
    expect(fitted.dockWidth).toBe(900 - DOCK_PAGE_MIN)
    expect(900 - fitted.dockWidth).toBeGreaterThanOrEqual(DOCK_PAGE_MIN)
  })
})

describe('dock width', () => {
  it('stays between its limits', () => {
    expect(clampDockWidth(100)).toBe(DOCK_MIN_WIDTH)
    expect(clampDockWidth(455.4)).toBe(455)
    expect(clampDockWidth(5000)).toBe(DOCK_MAX_WIDTH)
  })

  it('falls back to the designed width for nonsense', () => {
    expect(clampDockWidth('400')).toBe(DOCK_DEFAULT_WIDTH)
    expect(clampDockWidth(Number.NaN)).toBe(DOCK_DEFAULT_WIDTH)
    expect(clampDockWidth(undefined)).toBe(DOCK_DEFAULT_WIDTH)
  })

  it('is fitted to the window it is in, and never under its own minimum', () => {
    expect(clampDockWidth(700, 1000)).toBe(1000 - DOCK_PAGE_MIN)
    expect(clampDockWidth(700, 2560)).toBe(700)
    expect(clampDockWidth(500, 500)).toBe(DOCK_MIN_WIDTH)
  })
})

describe('dock memory', () => {
  it('starts open at the designed width', () => {
    expect(readDockPrefs(fakeStore())).toEqual({ width: DOCK_DEFAULT_WIDTH, open: true })
    expect(readDockPrefs(null)).toEqual({ width: DOCK_DEFAULT_WIDTH, open: true })
  })

  it('survives broken storage', () => {
    expect(readDockPrefs(fakeStore({ [DOCK_PREF_KEY]: '{nope' }))).toEqual({ width: DOCK_DEFAULT_WIDTH, open: true })
    expect(readDockPrefs(fakeStore({ [DOCK_PREF_KEY]: '[1,2]' }))).toEqual({ width: DOCK_DEFAULT_WIDTH, open: true })
    expect(readDockPrefs(fakeStore({ [DOCK_PREF_KEY]: JSON.stringify({ width: 9999, open: 'x' }) }))).toEqual({ width: DOCK_MAX_WIDTH, open: true })
  })

  it('writes a clean record', () => {
    const store = fakeStore()
    writeDockPrefs({ width: 512.7, open: false }, store)
    expect(store.values.get(DOCK_PREF_KEY)).toBe(JSON.stringify({ width: 513, open: false }))
  })

  it('remembers the width and the folded state across a restart', () => {
    const disk = fakeStore()
    const first = createWorkspace(disk)
    expect(first.getState()).toMatchObject({ dockWidth: DOCK_DEFAULT_WIDTH, dockOpen: true })
    // A drag only reaches storage when it ends.
    first.getState().setDockWidth(540)
    expect(disk.values.has(DOCK_PREF_KEY)).toBe(false)
    first.getState().commit()
    first.getState().setDockOpen(false)
    // The app starts again on the same device.
    const second = createWorkspace(disk)
    expect(second.getState()).toMatchObject({ dockWidth: 540, dockOpen: false })
    second.getState().toggleDock()
    expect(createWorkspace(disk).getState().dockOpen).toBe(true)
  })

  it('fits a drag to the window and resets on a double click', () => {
    const disk = fakeStore()
    const store = createWorkspace(disk)
    store.getState().setDockWidth(5000, 1200)
    expect(store.getState().dockWidth).toBe(DOCK_MAX_WIDTH)
    store.getState().setDockWidth(5000, 900)
    expect(store.getState().dockWidth).toBe(900 - DOCK_PAGE_MIN)
    store.getState().resetDockWidth()
    expect(store.getState().dockWidth).toBe(DOCK_DEFAULT_WIDTH)
    expect(createWorkspace(disk).getState().dockWidth).toBe(DOCK_DEFAULT_WIDTH)
  })

  it('works with no storage at all', () => {
    const store = createWorkspace(null)
    store.getState().setDockOpen(false)
    store.getState().commit()
    expect(store.getState().dockOpen).toBe(false)
  })
})

describe('Escape in browser view', () => {
  it('leaves full screen first, then the browser view', () => {
    expect(escapeAction({ inField: false, overlayOpen: false, full: true })).toBe('leave-full')
    expect(escapeAction({ inField: false, overlayOpen: false, full: false })).toBe('leave-view')
  })

  it('never takes the page from someone typing in the docked chat', () => {
    expect(escapeAction({ inField: true, overlayOpen: false, full: false })).toBe('none')
    // Full screen still ends from a field: the way back must always work.
    expect(escapeAction({ inField: true, overlayOpen: false, full: true })).toBe('leave-full')
  })

  it('leaves Escape to an open dialog or palette', () => {
    expect(escapeAction({ inField: false, overlayOpen: true, full: true })).toBe('none')
    expect(escapeAction({ inField: false, overlayOpen: true, full: false })).toBe('none')
  })
})
