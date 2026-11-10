/**
 * The guide overlay's life cycle (10 Nov 2026), with fake windows: what is created, where it is placed, what is
 * drawn in it, when it hides, and that every end path closes it. Also the capture-privacy registry that decides
 * which windows are hidden from screen sharing, and the rule for what this computer can really hide.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CapturePrivacy, type ProtectableWindow } from '../src/main/capture-privacy'
import { displayFor, GuideOverlay, overlayLabel, stepChip, type OverlayEvent, type OverlayHost, type OverlaySurface } from '../src/main/overlay/guide-overlay'
import { overlayHtml, overlaySetScript, parseOverlayEvent, OVERLAY_EVENT, type OverlayPageState } from '../src/main/overlay/overlay-page'
import type { Rect } from '../src/main/overlay/rect'
import { ACCENTS, brandLook } from '../src/shared/brand'
import { captureExclusion, chatHint, guidesHint, guidesUseOverlay, shouldProtect } from '../src/shared/capture-privacy'

class FakeSurface implements OverlaySurface {
  bounds: Rect | null = null
  visible = false
  destroyed = false
  clickable = false
  pushed: Array<OverlayPageState | null> = []
  looks: string[] = []
  shows = 0
  hides = 0
  /** What the system adds to an asked position (a scaled screen rounding). */
  drift = { x: 0, y: 0 }
  private listener: ((event: OverlayEvent) => void) | null = null
  constructor(readonly owner: object | undefined, private readonly protect: () => boolean) {}
  setBounds(bounds: Rect): Rect {
    this.bounds = { x: bounds.x + this.drift.x, y: bounds.y + this.drift.y, width: bounds.width, height: bounds.height }
    return this.bounds
  }
  show(): void { this.visible = true; this.shows++ }
  hide(): void { this.visible = false; this.hides++ }
  destroy(): void { this.destroyed = true; this.visible = false }
  push(state: OverlayPageState | null): void { this.pushed.push(state) }
  restyle(look: ReturnType<typeof brandLook>): void { this.looks.push(look.primary) }
  setClickable(on: boolean): void { this.clickable = on }
  onEvent(listener: (event: OverlayEvent) => void): void { this.listener = listener }
  isProtected(): boolean { return this.protect() }
  isDestroyed(): boolean { return this.destroyed }
  emit(event: OverlayEvent): void { this.listener?.(event) }
  get last(): OverlayPageState | null { return this.pushed[this.pushed.length - 1] ?? null }
}

function fakeHost(displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 }], protect = true): OverlayHost & { made: FakeSurface[] } {
  const made: FakeSurface[] = []
  return {
    made,
    displays: () => displays,
    createSurface: ({ owner }) => {
      const surface = new FakeSurface(owner, () => protect)
      made.push(surface)
      return surface
    },
  }
}

const look = brandLook({ theme: 'light', accent: 'ocean' })

describe('guide overlay (screen coordinates)', () => {
  it('draws the ring on the display the rectangle is on, in that window\'s own coordinates', () => {
    const host = fakeHost([
      { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 },
      { id: 2, bounds: { x: -1920, y: -200, width: 1920, height: 1080 }, scaleFactor: 1 },
    ])
    const overlay = new GuideOverlay(host)
    expect(host.made.length).toBe(0)
    overlay.show({ rect: { x: 300, y: 200, width: 120, height: 40 }, label: 'Click Save', step: 2, of: 5, look })
    expect(host.made.length).toBe(1)
    const first = host.made[0]!
    expect(first.owner).toBeUndefined()
    expect(first.bounds).toEqual({ x: 0, y: 0, width: 1536, height: 864 })
    expect(first.visible).toBe(true)
    expect(first.last).toEqual({ clip: { x: 0, y: 0, width: 1536, height: 864 }, ring: { x: 300, y: 200, width: 120, height: 40 }, k: 1, tag: null, n: '2/5', label: 'Click Save' })
    expect(overlay.state()).toMatchObject({ shown: true, displayId: 1, protected: true, windows: 1 })

    // The thing moved to the second monitor (negative coordinates): that display's window draws it, the first hides.
    overlay.move({ x: -1000, y: 100, width: 80, height: 30 })
    expect(host.made.length).toBe(2)
    const second = host.made[1]!
    expect(second.bounds).toEqual({ x: -1920, y: -200, width: 1920, height: 1080 })
    expect(second.last?.ring).toEqual({ x: 920, y: 300, width: 80, height: 30 })
    expect(first.visible).toBe(false)
    expect(first.last).toBeNull()
    expect(overlay.state().displayId).toBe(2)

    overlay.hide()
    expect(second.visible).toBe(false)
    expect(overlay.state()).toMatchObject({ shown: false, rect: null })
    // Windows are kept for the next ring, and closed by destroyAll.
    expect(host.made.every((s) => !s.destroyed)).toBe(true)
    overlay.destroyAll()
    expect(host.made.every((s) => s.destroyed)).toBe(true)
    expect(overlay.state().windows).toBe(0)
    // move after the end draws nothing and makes no window.
    overlay.move({ x: 10, y: 10, width: 10, height: 10 })
    expect(host.made.length).toBe(2)
  })

  it('with an owner covers only its area, clips to it, and places from where the window really is', () => {
    const host = fakeHost()
    const overlay = new GuideOverlay(host)
    const owner = { id: 'main window' }
    const area = { x: 400.4, y: 120.6, width: 600.2, height: 500 }
    overlay.show({ rect: { x: 500, y: 300, width: 100, height: 30 }, label: 'Type the name', look, owner, area, clip: { x: 450, y: 150, width: 300, height: 400 }, labelAt: { x: 500, y: 340, width: 220 }, scale: 1.25 })
    const s = host.made[0]!
    expect(s.owner).toBe(owner)
    // Whole DIPs that cover the area.
    expect(s.bounds).toEqual({ x: 400, y: 120, width: 601, height: 501 })
    expect(s.last).toEqual({ clip: { x: 50, y: 30, width: 300, height: 400 }, ring: { x: 100, y: 180, width: 100, height: 30 }, k: 1.25, tag: { x: 100, y: 220, width: 220 }, n: '', label: 'Type the name' })

    // The system put the window one DIP off (a scaled screen): the drawing is placed from the real position.
    s.drift = { x: 1, y: -1 }
    overlay.move({ x: 500, y: 300, width: 100, height: 30 }, { area: { x: 300, y: 100, width: 700, height: 520 } })
    expect(s.bounds).toEqual({ x: 301, y: 99, width: 700, height: 520 })
    expect(s.last?.ring).toEqual({ x: 199, y: 201, width: 100, height: 30 })

    // Scrolled out of the clip: nothing is drawn and the window hides; back in: it shows again.
    overlay.move({ x: 500, y: 900, width: 100, height: 30 })
    expect(s.visible).toBe(false)
    expect(s.last).toBeNull()
    expect(overlay.state().shown).toBe(false)
    overlay.move({ x: 500, y: 300, width: 100, height: 30 })
    expect(s.visible).toBe(true)
    expect(overlay.state().shown).toBe(true)
    // An empty clip (the view is covered or gone) hides it too.
    overlay.move({ x: 500, y: 300, width: 100, height: 30 }, { clip: { x: 0, y: 0, width: 0, height: 0 } })
    expect(s.visible).toBe(false)
    overlay.destroyAll()
    expect(s.destroyed).toBe(true)
  })

  it('takes the mouse only over a button, passes his press on, and restyles live', () => {
    const host = fakeHost()
    const overlay = new GuideOverlay(host)
    const acts: string[] = []
    overlay.show({ rect: { x: 10, y: 10, width: 50, height: 20 }, label: 'Click it', look, onAct: (outcome) => acts.push(outcome) })
    const s = host.made[0]!
    expect(s.clickable).toBe(false)
    s.emit({ type: 'hover', on: true })
    expect(s.clickable).toBe(true)
    s.emit({ type: 'act', outcome: 'done' })
    s.emit({ type: 'hover', on: false })
    expect(s.clickable).toBe(false)
    expect(acts).toEqual(['done'])
    const rose = brandLook({ theme: 'dark', accent: 'rose' })
    overlay.restyle(rose)
    expect(s.looks).toEqual([rose.primary])
    // A different look on the next show restyles the window that is already there.
    overlay.show({ rect: { x: 10, y: 10, width: 50, height: 20 }, label: 'Again', look })
    expect(s.looks).toEqual([rose.primary, look.primary])
    // Hidden: a late hover or press does nothing.
    overlay.hide()
    s.emit({ type: 'hover', on: true })
    s.emit({ type: 'act', outcome: 'skipped' })
    expect(s.clickable).toBe(false)
    expect(acts).toEqual(['done'])
  })

  it('words the label: step chip, clipboard fill, and never a sensitive value', () => {
    expect(stepChip(2, 5)).toBe('2/5')
    expect(stepChip(1, 1)).toBe('')
    expect(stepChip(undefined, undefined)).toBe('')
    expect(overlayLabel({ label: 'Click Save' })).toBe('Click Save')
    expect(overlayLabel({ label: 'Type the name', fill: { field: 'Pixel name', value: 'Cosmiprint' } })).toBe('Pixel name: Cosmiprint, press Ctrl+V')
    const secret = overlayLabel({ label: 'Password', fill: { field: 'Password', value: 'hunter2-secret', sensitive: true, pasteKey: 'Cmd+V' } })
    expect(secret).toBe('Password: on your clipboard, press Cmd+V')
    expect(secret).not.toContain('hunter2')
    const host = fakeHost()
    const overlay = new GuideOverlay(host)
    overlay.show({ rect: { x: 1, y: 1, width: 5, height: 5 }, label: 'Password', fill: { field: 'Password', value: 'hunter2-secret', sensitive: true }, look })
    expect(JSON.stringify(host.made[0]!.pushed)).not.toContain('hunter2')
  })

  it('picks the display holding the rectangle, else the nearest', () => {
    const displays = [
      { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 1 },
      { id: 2, bounds: { x: 1000, y: 0, width: 1000, height: 800 }, scaleFactor: 1.5 },
    ]
    expect(displayFor({ x: 10, y: 10, width: 10, height: 10 }, displays)?.id).toBe(1)
    expect(displayFor({ x: 1500, y: 10, width: 10, height: 10 }, displays)?.id).toBe(2)
    expect(displayFor({ x: 2500, y: 900, width: 10, height: 10 }, displays)?.id).toBe(2)
    expect(displayFor({ x: 0, y: 0, width: 1, height: 1 }, [])).toBeNull()
  })
})

describe('overlay page', () => {
  it('is the same drawing as the in-page guide, in the app\'s own colours only', () => {
    const html = overlayHtml(look)
    const ocean = ACCENTS.find((a) => a.id === 'ocean')!
    expect(html).toContain(`border:3px solid ${ocean.light![0]}`)
    expect(html).toContain('I did it')
    expect(html).toContain('Skip')
    for (const file of ['overlay-page.ts', 'overlay-window.ts', 'guide-overlay.ts', 'rect.ts']) {
      const src = readFileSync(join(__dirname, '../src/main/overlay', file), 'utf8')
      expect(src, file).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(src, file).not.toMatch(/rgba?\(/i)
    }
    expect(overlaySetScript(null)).toContain('set(null)')
  })

  it('reads only its own console lines', () => {
    expect(parseOverlayEvent('hello')).toBeNull()
    expect(parseOverlayEvent(`${OVERLAY_EVENT}{"type":"hover","on":true}`)).toEqual({ type: 'hover', on: true })
    expect(parseOverlayEvent(`${OVERLAY_EVENT}{"type":"act","outcome":"done"}`)).toEqual({ type: 'act', outcome: 'done' })
    expect(parseOverlayEvent(`${OVERLAY_EVENT}{"type":"act","outcome":"clicked"}`)).toBeNull()
    expect(parseOverlayEvent(`${OVERLAY_EVENT}{nope`)).toBeNull()
  })
})

class FakeWindow implements ProtectableWindow {
  calls: boolean[] = []
  destroyed = false
  private closed: (() => void) | null = null
  setContentProtection(enable: boolean): void { this.calls.push(enable) }
  isDestroyed(): boolean { return this.destroyed }
  once(_event: 'closed', listener: () => void): void { this.closed = listener }
  close(): void { this.destroyed = true; this.closed?.() }
  get on(): boolean | undefined { return this.calls[this.calls.length - 1] }
}

describe('capture privacy', () => {
  it('knows what each system can really hide', () => {
    expect(captureExclusion('win32', '10.0.26200')).toBe('full')
    expect(captureExclusion('win32', '10.0.19041')).toBe('full')
    expect(captureExclusion('win32', '10.0.18363')).toBe('none')
    expect(captureExclusion('win32', '6.3.9600')).toBe('none')
    expect(captureExclusion('win32', '')).toBe('none')
    expect(captureExclusion('darwin', '24.1.0')).toBe('partial')
    expect(captureExclusion('linux', '6.8.0')).toBe('none')
    expect(guidesUseOverlay(true, 'full')).toBe(true)
    expect(guidesUseOverlay(true, 'partial')).toBe(true)
    expect(guidesUseOverlay(true, 'none')).toBe(false)
    expect(guidesUseOverlay(false, 'full')).toBe(false)
    // The hint never promises what the system cannot do.
    expect(guidesHint('linux')).toMatch(/Not available/)
    expect(guidesHint('linux')).toMatch(/screen share shows them/)
    expect(guidesHint('darwin')).toMatch(/can still capture/)
    expect(guidesHint('win32')).toMatch(/version 2004/)
    expect(chatHint('win32')).toMatch(/whole window/)
    expect(chatHint('linux')).toMatch(/Not available/)
  })

  it('hides each window by its role and follows the settings live', () => {
    const settings = { hideGuidesFromCapture: true, hideChatFromCapture: false }
    const privacy = new CapturePrivacy(() => settings, 'full')
    const guide = new FakeWindow()
    const main = new FakeWindow()
    const quick = new FakeWindow()
    privacy.register(guide, 'guide')
    privacy.register(main, 'main')
    privacy.register(quick, 'chat')
    expect([guide.on, main.on, quick.on]).toEqual([true, false, false])
    expect(privacy.protects(guide)).toBe(true)

    // Hide the chat: the chat is part of the app window, so the whole window is hidden (and the quick ask window).
    settings.hideChatFromCapture = true
    privacy.apply()
    expect([guide.on, main.on, quick.on]).toEqual([true, true, true])
    // Nothing is asked twice.
    const before = main.calls.length
    privacy.apply()
    expect(main.calls.length).toBe(before)

    // The docked chat gets a window of its own: that window is hidden and the app window is shown again.
    const dock = new FakeWindow()
    privacy.register(dock, 'chat', { docksMainChat: true })
    expect([dock.on, main.on]).toEqual([true, false])
    // The dock closes: the app window holds the chat again, so it is hidden again.
    dock.close()
    expect(main.on).toBe(true)

    settings.hideGuidesFromCapture = false
    settings.hideChatFromCapture = false
    privacy.apply()
    expect([guide.on, main.on, quick.on]).toEqual([false, false, false])
    expect(privacy.protects(guide)).toBe(false)
  })

  it('asks nothing of a system that cannot hide a window', () => {
    const privacy = new CapturePrivacy(() => ({ hideGuidesFromCapture: true, hideChatFromCapture: true }), 'none')
    const win = new FakeWindow()
    privacy.register(win, 'main')
    expect(win.on).toBe(false)
    expect(privacy.protects(win)).toBe(false)
    expect(shouldProtect('main', { hideGuidesFromCapture: false, hideChatFromCapture: true }, { chatHasOwnWindow: true })).toBe(false)
  })
})
