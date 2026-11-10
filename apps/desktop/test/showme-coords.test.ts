/**
 * Screen pixels to DIPs for "show me how" (main/showme/coords.ts and overlay-adapter.ts): the screen reader gives
 * physical pixels, the overlay draws in DIPs per display. Checked at 100%, 125% (his screen) and 150%, and with a
 * second display at a negative origin and another scale, down to what the shared overlay is finally told to draw.
 */
import { describe, expect, it } from 'vitest'

import { brandLook } from '../src/shared/brand'
import { GuideOverlay, type OverlayHost, type OverlaySurface } from '../src/main/overlay/guide-overlay'
import type { OverlayPageState } from '../src/main/overlay/overlay-page'
import { contains, displayOfPixels, displaysOf, toDip, toPixels, type ScreenDisplay } from '../src/main/showme/coords'
import { walkOverlay, type RingOverlay } from '../src/main/showme/overlay-adapter'
import type { Rect } from '../src/main/showme/screen'

const look = (): ReturnType<typeof brandLook> => brandLook({ theme: 'light' })

/** One 1920 by 1080 panel at a scale: its DIP size shrinks as the scale grows. */
function single(scale: number): ScreenDisplay[] {
  return [{ id: 1, scaleFactor: scale, pixel: { x: 0, y: 0, width: 1920, height: 1080 }, dip: { x: 0, y: 0, width: 1920 / scale, height: 1080 / scale } }]
}

/** His desk: the 125% laptop panel as primary, and a 2560 by 1440 monitor at 150% to its LEFT (negative x). */
const TWO: ScreenDisplay[] = [
  { id: 1, scaleFactor: 1.25, pixel: { x: 0, y: 0, width: 1920, height: 1080 }, dip: { x: 0, y: 0, width: 1536, height: 864 } },
  { id: 2, scaleFactor: 1.5, pixel: { x: -2560, y: -200, width: 2560, height: 1440 }, dip: { x: -1707, y: -133, width: 1707, height: 960 } },
]

describe('one display', () => {
  it('leaves a rectangle alone at 100%', () => {
    expect(toDip({ x: 1000, y: 500, width: 200, height: 40 }, single(1))).toEqual({ displayId: 1, rect: { x: 1000, y: 500, width: 200, height: 40 } })
  })

  it('divides by 1.25 at 125%', () => {
    expect(toDip({ x: 1000, y: 500, width: 200, height: 40 }, single(1.25))).toEqual({ displayId: 1, rect: { x: 800, y: 400, width: 160, height: 32 } })
  })

  it('divides by 1.5 at 150%', () => {
    const at = toDip({ x: 900, y: 600, width: 300, height: 60 }, single(1.5))!
    expect(at.rect).toEqual({ x: 600, y: 400, width: 200, height: 40 })
  })

  it('goes there and back without drifting, at every scale', () => {
    for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
      const displays = single(scale)
      const rect = { x: 1234, y: 567, width: 89, height: 21 }
      const back = toPixels(toDip(rect, displays)!.rect, displays[0]!)
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(back[key]).toBeCloseTo(rect[key], 6)
    }
  })
})

describe('two displays, the second at a negative origin with its own scale', () => {
  it('finds the display by where the thing is in pixels', () => {
    expect(displayOfPixels({ x: 100, y: 100, width: 10, height: 10 }, TWO)?.id).toBe(1)
    expect(displayOfPixels({ x: -1000, y: 300, width: 10, height: 10 }, TWO)?.id).toBe(2)
    // Off every display (a window dragged half out): the nearest one.
    expect(displayOfPixels({ x: 5000, y: 100, width: 10, height: 10 }, TWO)?.id).toBe(1)
    expect(displayOfPixels({ x: 0, y: 0, width: 1, height: 1 }, [])).toBeNull()
  })

  it('scales around the second display its own two origins', () => {
    // 300 pixels right and 150 down from that display's top left: 200 and 100 DIPs from its DIP top left.
    const at = toDip({ x: -2560 + 300, y: -200 + 150, width: 150, height: 60 }, TWO)!
    expect(at.displayId).toBe(2)
    expect(at.rect).toEqual({ x: -1707 + 200, y: -133 + 100, width: 100, height: 40 })
  })

  it('keeps the primary display on its own scale', () => {
    expect(toDip({ x: 500, y: 250, width: 125, height: 50 }, TWO)).toEqual({ displayId: 1, rect: { x: 400, y: 200, width: 100, height: 40 } })
  })

  it('a click in pixels hits the same rectangle whatever the scale', () => {
    const button = { x: -2000, y: 300, width: 150, height: 60 }
    expect(contains(button, -1990, 310)).toBe(true)
    expect(contains(button, -2004, 300, 6)).toBe(true)
    expect(contains(button, -2010, 300, 6)).toBe(false)
  })
})

describe('reading the displays from the system', () => {
  it('asks Windows where each display is in pixels', () => {
    const displays = displaysOf({
      getAllDisplays: () => [
        { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 },
        { id: 2, bounds: { x: -1707, y: -133, width: 1707, height: 960 }, scaleFactor: 1.5 },
      ],
      dipToScreenRect: (_window, rect) => (rect.x === 0 ? { x: 0, y: 0, width: 1920, height: 1080 } : { x: -2560, y: -200, width: 2560, height: 1440 }),
    })
    expect(displays).toEqual(TWO)
  })

  it('scales the DIP bounds where the system cannot say', () => {
    const displays = displaysOf({ getAllDisplays: () => [{ id: 7, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 }] })
    expect(displays[0]!.pixel).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })
})

/** The shared overlay with windows that only remember what they were told to draw. */
function fakeOverlay(displays: ScreenDisplay[]): { overlay: GuideOverlay; drawn: Map<string, OverlayPageState | null>; bounds: Map<string, Rect> } {
  const drawn = new Map<string, OverlayPageState | null>()
  const bounds = new Map<string, Rect>()
  let seq = 0
  const host: OverlayHost = {
    displays: () => displays.map((display) => ({ id: display.id, bounds: display.dip, scaleFactor: display.scaleFactor })),
    createSurface: (): OverlaySurface => {
      const key = `s${++seq}`
      let gone = false
      return {
        setBounds: (rect) => {
          bounds.set(key, rect)
          return rect
        },
        show: () => undefined,
        hide: () => undefined,
        destroy: () => {
          gone = true
        },
        push: (state) => {
          drawn.set(key, state)
        },
        restyle: () => undefined,
        setClickable: () => undefined,
        onEvent: () => undefined,
        isProtected: () => true,
        isDestroyed: () => gone,
      }
    },
  }
  return { overlay: new GuideOverlay(host), drawn, bounds }
}

describe('what the shared overlay is finally told to draw', () => {
  it('rings a button on the 125% display in that display its own window coordinates', () => {
    const { overlay, drawn } = fakeOverlay(TWO)
    const ring = walkOverlay(overlay, () => TWO, look)
    ring.show({ rect: { x: 1000, y: 500, width: 200, height: 40 }, label: 'Click Save', step: 2, of: 5 })
    expect(overlay.state()).toMatchObject({ shown: true, displayId: 1, rect: { x: 800, y: 400, width: 160, height: 32 }, protected: true })
    const page = [...drawn.values()].find((state) => state !== null)!
    expect(page.ring).toEqual({ x: 800, y: 400, width: 160, height: 32 })
    expect(page.label).toBe('Click Save')
    expect(page.n).toBe('2/5')
  })

  it('rings a button on the second display in THAT window, and moves it there', () => {
    const { overlay, drawn, bounds } = fakeOverlay(TWO)
    const ring = walkOverlay(overlay, () => TWO, look)
    ring.show({ rect: { x: -2260, y: -50, width: 150, height: 60 }, label: 'Click Export', step: 1, of: 2 })
    expect(overlay.state()).toMatchObject({ shown: true, displayId: 2 })
    // The window covers the second display; the ring is drawn 200, 100 DIPs from its corner.
    expect([...bounds.values()].at(-1)).toMatchObject({ x: -1707, y: -133 })
    expect([...drawn.values()].find((state) => state !== null)!.ring).toEqual({ x: 200, y: 100, width: 100, height: 40 })
    // It scrolls 150 pixels down: 100 DIPs.
    ring.move({ x: -2260, y: 100, width: 150, height: 60 })
    expect(overlay.state().rect).toEqual({ x: -1507, y: 67, width: 100, height: 40 })
  })

  it('hands the ring to the other display when the window is dragged across', () => {
    const { overlay } = fakeOverlay(TWO)
    const ring = walkOverlay(overlay, () => TWO, look)
    ring.show({ rect: { x: 100, y: 100, width: 125, height: 50 }, label: 'Click Save', step: 1, of: 1 })
    expect(overlay.state().displayId).toBe(1)
    ring.move({ x: -1500, y: 300, width: 150, height: 60 })
    expect(overlay.state()).toMatchObject({ shown: true, displayId: 2 })
    ring.hide()
    expect(overlay.state().shown).toBe(false)
  })

  it('passes a clipboard fill through with this computer its paste key, and never a secret value', () => {
    const shows: Array<Parameters<RingOverlay['show']>[0]> = []
    const ring = walkOverlay({ show: (spec) => void shows.push(spec), move: () => undefined, hide: () => undefined }, () => single(1.25), look, 'Ctrl+V')
    ring.show({ rect: { x: 0, y: 0, width: 100, height: 20 }, label: 'Paste the name', step: 1, of: 2, fill: { field: 'Pixel name', value: 'Northwind' } })
    ring.show({ rect: { x: 0, y: 0, width: 100, height: 20 }, label: 'Paste the key', step: 2, of: 2, fill: { field: 'Key', sensitive: true } })
    expect(shows[0]!.fill).toEqual({ field: 'Pixel name', value: 'Northwind', pasteKey: 'Ctrl+V' })
    expect(shows[1]!.fill).toEqual({ field: 'Key', sensitive: true, pasteKey: 'Ctrl+V' })
    // Through the real overlay the label is the same wording the in-app guide uses.
    const { overlay, drawn } = fakeOverlay(single(1.25))
    const real = walkOverlay(overlay, () => single(1.25), look)
    real.show({ rect: { x: 100, y: 100, width: 100, height: 20 }, label: 'Paste the name', step: 1, of: 2, fill: { field: 'Pixel name', value: 'Northwind' } })
    expect([...drawn.values()].find((state) => state !== null)!.label).toBe('Pixel name: Northwind, press Ctrl+V')
    real.show({ rect: { x: 100, y: 100, width: 100, height: 20 }, label: 'Paste the key', step: 2, of: 2, fill: { field: 'Key', sensitive: true } })
    expect([...drawn.values()].find((state) => state !== null)!.label).toBe('Key: on your clipboard, press Ctrl+V')
  })
})
