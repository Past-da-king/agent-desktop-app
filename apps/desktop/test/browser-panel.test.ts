import { describe, expect, it } from 'vitest'

import { skyHopDemo } from '../src/renderer/bridge/seed'
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_PREF_KEY,
  boundsFor,
  clampPanelWidth,
  displayUrl,
  readPanelPrefs,
  writePanelPrefs,
} from '../src/renderer/lib/panel'

function fakeStore(initial: Record<string, string> = {}): {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  values: Map<string, string>
} {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe('browser panel width', () => {
  it('keeps the splitter between 320 and 560', () => {
    expect(clampPanelWidth(200)).toBe(PANEL_MIN_WIDTH)
    expect(clampPanelWidth(400)).toBe(400)
    expect(clampPanelWidth(900)).toBe(PANEL_MAX_WIDTH)
    expect(clampPanelWidth(399.6)).toBe(400)
  })

  it('falls back to the designed width for nonsense', () => {
    expect(clampPanelWidth('420')).toBe(PANEL_DEFAULT_WIDTH)
    expect(clampPanelWidth(Number.NaN)).toBe(PANEL_DEFAULT_WIDTH)
    expect(clampPanelWidth(Number.POSITIVE_INFINITY)).toBe(PANEL_DEFAULT_WIDTH)
    expect(clampPanelWidth(null)).toBe(PANEL_DEFAULT_WIDTH)
  })

  it('remembers the width and the collapsed state', () => {
    const store = fakeStore()
    writePanelPrefs({ width: 470, collapsed: true }, store)
    const saved = store.values.get(PANEL_PREF_KEY)
    expect(saved).toBe(JSON.stringify({ width: 470, collapsed: true }))
    expect(readPanelPrefs(store)).toEqual({ width: 470, collapsed: true })
  })

  it('repairs out-of-range or broken stored values', () => {
    const clamped = fakeStore({ [PANEL_PREF_KEY]: JSON.stringify({ width: 900, collapsed: 'yes' }) })
    expect(readPanelPrefs(clamped)).toEqual({ width: PANEL_MAX_WIDTH, collapsed: false })

    const broken = fakeStore({ [PANEL_PREF_KEY]: '{not json' })
    expect(readPanelPrefs(broken)).toEqual({ width: PANEL_DEFAULT_WIDTH, collapsed: false })

    const missing = fakeStore()
    expect(readPanelPrefs(missing)).toEqual({ width: PANEL_DEFAULT_WIDTH, collapsed: false })
    expect(readPanelPrefs(null)).toEqual({ width: PANEL_DEFAULT_WIDTH, collapsed: false })
  })
})

describe('browser panel bounds', () => {
  it('rounds the reserved rectangle into window pixels', () => {
    expect(boundsFor({ left: 10.4, top: 86.6, width: 379.5, height: 288.2 }, true)).toEqual({
      x: 10,
      y: 87,
      width: 380,
      height: 288,
      visible: true,
    })
  })

  it('hides the view when the panel is closed or the slot has no size', () => {
    expect(boundsFor({ left: 0, top: 0, width: 380, height: 288 }, false).visible).toBe(false)
    expect(boundsFor({ left: 0, top: 0, width: 0, height: 288 }, true).visible).toBe(false)
    expect(boundsFor({ left: 0, top: 0, width: 380, height: 0 }, true).visible).toBe(false)
  })

  it('never reports a negative rectangle', () => {
    expect(boundsFor({ left: 0, top: 0, width: -10, height: -4 }, true)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      visible: false,
    })
  })

  it('shows the address without the scheme', () => {
    expect(displayUrl('https://skyhop.example/flights')).toBe('skyhop.example/flights')
    expect(displayUrl(' http://127.0.0.1:8080/a ')).toBe('127.0.0.1:8080/a')
    expect(displayUrl('')).toBe('')
  })
})

describe('the SkyHop demo page', () => {
  it('still has the three flights, one selected, for the mock panel', () => {
    expect(skyHopDemo.brand).toBe('SkyHop')
    expect(skyHopDemo.flights).toHaveLength(3)
    expect(skyHopDemo.flights.filter((flight) => flight.selected)).toHaveLength(1)
    expect(skyHopDemo.flights[0]?.time).toBe('06:05')
  })
})
