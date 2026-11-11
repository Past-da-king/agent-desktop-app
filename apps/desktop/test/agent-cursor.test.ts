import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { brandLook } from '../src/shared/brand'
import { AgentCursors, FOLLOW_MS, IDLE_HIDE_MS, type CursorHost, type CursorPageState, type CursorSurface, type Located } from '../src/main/overlay/agent-cursor'
import { cursorHtml, cursorStyle } from '../src/main/overlay/agent-cursor-page'
import { browserCursorAt, cursorLabel } from '../src/main/browser/agent-cursor-link'
import { keepFocus, type FocusProbe } from '../src/main/browser/focus-keeper'

class FakeSurface implements CursorSurface {
  bounds = { x: 0, y: 0, width: 0, height: 0 }
  shown = false
  destroyed = false
  last: CursorPageState | null = null
  setBounds(b: { x: number; y: number; width: number; height: number }) {
    this.bounds = b
    return b
  }
  show() {
    this.shown = true
  }
  hide() {
    this.shown = false
  }
  destroy() {
    this.destroyed = true
  }
  push(state: CursorPageState | null) {
    this.last = state
  }
  restyle() {}
  isProtected() {
    return true
  }
  isDestroyed() {
    return this.destroyed
  }
}

function setup(on = { value: true }) {
  const surfaces: FakeSurface[] = []
  const host: CursorHost = {
    displays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
    createSurface: () => {
      const s = new FakeSurface()
      surfaces.push(s)
      return s
    },
  }
  const clock = { t: 1000 }
  const cursors = new AgentCursors(host, { enabled: () => on.value, look: () => brandLook(), now: () => clock.t, timers: false })
  return { cursors, surfaces, clock, on }
}

describe('agent cursor logic', () => {
  it('shows a cursor with a label at the point, in window coordinates', async () => {
    const { cursors, surfaces } = setup()
    await cursors.show('main', { at: { x: 400, y: 300 }, label: 'Typing the invoice number' })
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]?.shown).toBe(true)
    expect(surfaces[0]?.last?.cursors[0]).toMatchObject({ id: 'main', x: 400, y: 300, label: 'Typing the invoice number' })
  })

  it('glides: a second move is the same cursor, a new place', async () => {
    const { cursors, surfaces } = setup()
    await cursors.show('main', { at: { x: 10, y: 10 } })
    await cursors.moveTo('main', { x: 700, y: 500 }, { label: 'Clicking Save' })
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]?.last?.cursors).toHaveLength(1)
    expect(surfaces[0]?.last?.cursors[0]).toMatchObject({ x: 700, y: 500, label: 'Clicking Save' })
  })

  it('pulses on a click (a new pulse number each time)', async () => {
    const { cursors, surfaces } = setup()
    await cursors.show('main', { at: { x: 5, y: 5 } })
    const a = surfaces[0]?.last?.cursors[0]?.pulse ?? 0
    cursors.click('main')
    cursors.click('main')
    expect(surfaces[0]?.last?.cursors[0]?.pulse).toBe(a + 2)
  })

  it('one cursor per running agent, each with its own label, named when there are several', async () => {
    const { cursors, surfaces } = setup()
    await cursors.show('main', { at: { x: 100, y: 100 }, label: 'Reading the page', who: 'main agent' })
    expect(surfaces[0]?.last?.cursors[0]?.who).toBe('')
    await cursors.show('helper:1', { at: { x: 900, y: 600 }, label: 'Typing the name', who: 'helper: Fix the build' })
    const spots = surfaces[0]?.last?.cursors ?? []
    expect(spots.map((s) => s.id).sort()).toEqual(['helper:1', 'main'])
    expect(spots.find((s) => s.id === 'helper:1')).toMatchObject({ label: 'Typing the name', who: 'helper: Fix the build' })
    expect(spots.find((s) => s.id === 'main')?.label).toBe('Reading the page')
  })

  it('disappears when its run ends, and the window is hidden when none is left', async () => {
    const { cursors, surfaces } = setup()
    await cursors.show('main', { at: { x: 1, y: 1 } })
    await cursors.show('helper:1', { at: { x: 2, y: 2 } })
    cursors.hide('main')
    expect(surfaces[0]?.last?.cursors.map((s) => s.id)).toEqual(['helper:1'])
    cursors.hide('helper:1')
    expect(surfaces[0]?.shown).toBe(false)
    expect(cursors.state().cursors).toHaveLength(0)
  })

  it('follows a window that moves, and hides while it is covered or minimised', async () => {
    const { cursors, surfaces } = setup()
    const where: { v: Located | null } = { v: { at: { x: 200, y: 200 }, visible: true } }
    await cursors.moveTo('main', () => where.v, { label: 'Clicking OK' })
    expect(surfaces[0]?.last?.cursors[0]).toMatchObject({ x: 200, y: 200 })
    where.v = { at: { x: 260, y: 240 }, visible: true }
    await cursors.tick()
    expect(surfaces[0]?.last?.cursors[0]).toMatchObject({ x: 260, y: 240 })
    where.v = { at: { x: 260, y: 240 }, visible: false }
    await cursors.tick()
    expect(surfaces[0]?.shown).toBe(false)
    where.v = { at: { x: 300, y: 240 }, visible: true }
    await cursors.tick()
    expect(surfaces[0]?.shown).toBe(true)
    where.v = null
    await cursors.tick()
    expect(surfaces[0]?.shown).toBe(false)
  })

  it('goes by itself when nobody moves it (a crashed run leaves nothing)', async () => {
    const { cursors, surfaces, clock } = setup()
    await cursors.show('main', { at: { x: 1, y: 1 } })
    clock.t += IDLE_HIDE_MS + FOLLOW_MS
    await cursors.tick()
    expect(cursors.state().cursors).toHaveLength(0)
    expect(surfaces[0]?.shown).toBe(false)
  })

  it('does nothing with the setting off, and closes its windows when switched off', async () => {
    const { cursors, surfaces, on } = setup()
    on.value = false
    await cursors.show('main', { at: { x: 1, y: 1 } })
    cursors.click('main')
    expect(surfaces).toHaveLength(0)
    on.value = true
    await cursors.show('main', { at: { x: 1, y: 1 } })
    expect(surfaces).toHaveLength(1)
    on.value = false
    cursors.refresh()
    expect(surfaces[0]?.destroyed).toBe(true)
    expect(cursors.state().cursors).toHaveLength(0)
  })

  it('with an owner it covers only its area, and every window is protected like a guide', async () => {
    const { cursors, surfaces } = setup()
    const owner = {}
    await cursors.show('main', { owner, area: { x: 300, y: 100, width: 800, height: 600 }, locate: () => ({ at: { x: 500, y: 400 }, visible: true, area: { x: 300, y: 100, width: 800, height: 600 } }) })
    expect(surfaces[0]?.bounds).toEqual({ x: 300, y: 100, width: 800, height: 600 })
    expect(surfaces[0]?.last?.cursors[0]).toMatchObject({ x: 200, y: 300 })
    expect(cursors.state().protected).toBe(true)
  })
})

describe('agent cursor look', () => {
  it('is made of the brand look only: no colour of its own, never a system arrow, never takes input', () => {
    for (const dark of [false, true]) {
      const look = brandLook({ theme: dark ? 'dark' : 'light', accent: 'iris', systemDark: dark })
      const css = cursorStyle(look)
      expect(css).toContain(look.primary)
      expect(css).toContain(look.edge)
      const hex = css.match(/#[0-9a-fA-F]{6}\b/g) ?? []
      const allowed = new Set(Object.values(look).filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()))
      for (const h of hex) expect(allowed.has(h.toLowerCase())).toBe(true)
      expect(css).toContain('pointer-events:none')
      expect(css).not.toContain('cursor:')
    }
    expect(cursorHtml(brandLook())).toContain('__cursor')
  })
})

describe('agent cursor in the browser', () => {
  const view = { found: true, front: true, backstage: false, covered: false, view: { x: 100, y: 50, width: 800, height: 600 }, clip: { x: 100, y: 50, width: 800, height: 600 } }
  const win = { content: { x: 1000, y: 200 }, zoom: 1, visible: true }

  it('places a page point on the screen through the view and the window', () => {
    const found = browserCursorAt({ point: { x: 400, y: 300 }, pageWidth: 800, view, window: win })
    expect(found?.at).toEqual({ x: 1500, y: 550 })
    expect(found?.visible).toBe(true)
  })

  it('hides when the window is minimised, the tab is not in front, covered, or the point is scrolled out', () => {
    expect(browserCursorAt({ point: { x: 400, y: 300 }, pageWidth: 800, view, window: { ...win, visible: false } })?.visible).toBe(false)
    expect(browserCursorAt({ point: { x: 400, y: 300 }, pageWidth: 800, view: { ...view, front: false }, window: win })?.visible).toBe(false)
    expect(browserCursorAt({ point: { x: 400, y: 300 }, pageWidth: 800, view: { ...view, covered: true }, window: win })?.visible).toBe(false)
    expect(browserCursorAt({ point: { x: 400, y: 900 }, pageWidth: 800, view, window: win })?.visible).toBe(false)
    expect(browserCursorAt({ point: { x: 1, y: 1 }, pageWidth: 800, view: null, window: win })).toBeNull()
  })

  it('labels the step and never carries the typed text', () => {
    expect(cursorLabel('type', 'Invoice number')).toBe('Typing in Invoice number')
    expect(cursorLabel('click', 'Save')).toBe('Clicking Save')
    expect(cursorLabel('type', '')).toBe('Typing in the page')
  })
})

describe('focus keeper', () => {
  function probe(state: { app: boolean; host: boolean }): FocusProbe & { restored: number } {
    const p = {
      restored: 0,
      appFocused: () => state.app,
      hostFocused: () => state.host,
      saveActive: async () => {},
      restoreHost: async () => {
        p.restored += 1
        state.host = true
      },
    }
    return p
  }
  it('gives the chat box its keyboard back when a guest took it', async () => {
    const state = { app: true, host: true }
    const p = probe(state)
    const done = await keepFocus(p)
    state.host = false
    expect(await done()).toBe(true)
    expect(p.restored).toBe(1)
  })
  it('does nothing when he is in another app (it can never bring the app forward)', async () => {
    const state = { app: false, host: false }
    const p = probe(state)
    const done = await keepFocus(p)
    expect(await done()).toBe(false)
    expect(p.restored).toBe(0)
  })
  it('does nothing when the keyboard never moved', async () => {
    const state = { app: true, host: true }
    const p = probe(state)
    const done = await keepFocus(p)
    expect(await done()).toBe(false)
  })
})

describe('the agent browser never takes focus (source guard)', () => {
  const root = join(__dirname, '..', 'src', 'main')
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [] : e.name.endsWith('.ts') ? [join(root, dir, e.name)] : []))
  const watched = [...files('browser'), join(root, 'vault', 'browser-vault.ts'), join(root, 'tools', 'browser-pro.ts'), join(root, 'tools', 'vault.ts')]
  const BAD = /\b(?:win|window|child|this\.window|devToolsWebContents|wc|webContents)\??\.(?:focus|moveTop|setAlwaysOnTop)\(|Page\.bringToFront|SetForegroundWindow|robotjs|nut-js|SetCursorPos|mouse_event|keybd_event|SendInput|SendKeys|\.show\(\)/

  it('has no focus-taking call outside the few user-owned places', () => {
    const offenders: string[] = []
    for (const file of watched) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return
          if (BAD.test(line)) offenders.push(`${file.split('src/main/')[1]}:${i + 1}: ${line.trim()}`)
        })
    }
    // Allowed: opening the developer tools (his own action), the popup his OWN click opened, the keyboard given back
    // to the app's own page (focus-keeper), the show() that follows `if (this.personTab === opener.id)`.
    const allowed = offenders.filter((o) => !/devToolsWebContents\?\.focus|child\.show\(\)|child\.focus\(\)|w\.webContents\.focus\(\)/.test(o))
    expect(allowed).toEqual([])
  })

  it('opens an agent-made popup without activating it', () => {
    const src = readFileSync(join(root, 'browser', 'browser.ts'), 'utf8')
    const at = src.indexOf('child.showInactive()')
    expect(at).toBeGreaterThan(0)
    const before = src.slice(Math.max(0, at - 400), at)
    expect(before).toContain('this.personTab === opener.id')
  })

  it('turns focus emulation on for every agent tab and never calls bringToFront', () => {
    const src = readFileSync(join(root, 'browser', 'browser.ts'), 'utf8')
    expect(src).toContain("'Emulation.setFocusEmulationEnabled', { enabled: true }")
    expect(src).not.toMatch(/send\('Page\.bringToFront/)
  })
})
