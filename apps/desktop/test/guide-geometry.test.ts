/**
 * Page rectangle to screen rectangle (10 Nov 2026): the maths that keeps the private guide's ring on the element.
 * Every number here is worked by hand from the layout it describes.
 */
import { describe, expect, it } from 'vitest'

import { guideGeometry, pageToScreen } from '../src/main/browser/guide-geometry'
import { coverRect, intersect, localRect, toPhysical } from '../src/main/overlay/rect'

const base = {
  target: { x: 100, y: 50, width: 200, height: 40 },
  frame: { x: 0, y: 0, width: 1000, height: 700 },
  pageWidth: 1000,
  view: { x: 300, y: 80, width: 1000, height: 700 },
  viewClip: { x: 300, y: 80, width: 1000, height: 700 },
  windowZoom: 1,
  content: { x: 0, y: 0 },
}

describe('guide geometry', () => {
  it('adds the view offset inside the window and the window position on the screen', () => {
    const g = guideGeometry({ ...base, content: { x: 40, y: 25 } })!
    expect(g.k).toBe(1)
    expect(g.origin).toEqual({ x: 340, y: 105 })
    expect(g.target).toEqual({ x: 440, y: 155, width: 200, height: 40 })
    expect(g.clip).toEqual({ x: 340, y: 105, width: 1000, height: 700 })
    expect(g.visible).toBe(true)
  })

  it('is the same rectangle in DIPs at every screen scale; only the real pixels differ (1, 1.25, 1.5)', () => {
    const g = guideGeometry({ ...base, content: { x: 40, y: 25 } })!
    expect(toPhysical(g.target, 1)).toEqual({ x: 440, y: 155, width: 200, height: 40 })
    expect(toPhysical(g.target, 1.25)).toEqual({ x: 550, y: 194, width: 250, height: 50 })
    expect(toPhysical(g.target, 1.5)).toEqual({ x: 660, y: 233, width: 300, height: 60 })
    // An odd DIP edge at 125% lands between pixels: rounded edge by edge, never more than a pixel off.
    const odd = toPhysical({ x: 101, y: 33, width: 51, height: 17 }, 1.25)
    expect(odd).toEqual({ x: 126, y: 41, width: 64, height: 22 })
  })

  it('works on a second monitor left of and above the first (negative origin)', () => {
    const g = guideGeometry({ ...base, content: { x: -1800, y: -150 } })!
    expect(g.target).toEqual({ x: -1400, y: -20, width: 200, height: 40 })
    expect(g.clip.x).toBe(-1500)
    // That display: 1920x1080 at 100%, its pixels start at -1920,-200 like its DIPs.
    expect(toPhysical(g.target, 1, { dip: { x: -1920, y: -200 }, pixel: { x: -1920, y: -200 } })).toEqual({ x: -1400, y: -20, width: 200, height: 40 })
    // The same display at 150%, placed left of a primary whose pixels start at 0: 2880 real pixels wide.
    expect(toPhysical(g.target, 1.5, { dip: { x: -1920, y: -200 }, pixel: { x: -2880, y: -300 } })).toEqual({ x: -2100, y: -30, width: 300, height: 60 })
  })

  it('scales by what the page really measures: zoom, a page drawn smaller, the window\'s own zoom', () => {
    // Page zoom 125%: the page says it is 800 wide in a 1000 DIP view, so one page pixel is 1.25 DIPs.
    const zoomed = guideGeometry({ ...base, pageWidth: 800, frame: { x: 0, y: 0, width: 800, height: 560 } })!
    expect(zoomed.k).toBe(1.25)
    expect(zoomed.target).toEqual({ x: 300 + 125, y: 80 + 62.5, width: 250, height: 50 })
    // A 1440 wide desktop page drawn in a 720 wide card: half size.
    const small = guideGeometry({ ...base, pageWidth: 1440, frame: { x: 0, y: 0, width: 1440, height: 900 }, view: { x: 300, y: 80, width: 720, height: 450 }, viewClip: { x: 300, y: 80, width: 720, height: 450 } })!
    expect(small.k).toBe(0.5)
    expect(small.target).toEqual({ x: 350, y: 105, width: 100, height: 20 })
    // The app window itself zoomed to 110%: its own CSS pixels grow, the page's count of them does not.
    const win = guideGeometry({ ...base, windowZoom: 1.1 })!
    expect(win.k).toBeCloseTo(1.1, 10)
    expect(win.origin.x).toBeCloseTo(330, 10)
    expect(win.target.x).toBeCloseTo(330 + 110, 10)
    expect(win.target.width).toBeCloseTo(220, 10)
  })

  it('adds the iframe offset and clips to the iframe', () => {
    const g = guideGeometry({ ...base, target: { x: 30, y: 30, width: 90, height: 24 }, frame: { x: 200, y: 400, width: 400, height: 160 }, content: { x: 10, y: 10 } })!
    expect(g.origin).toEqual({ x: 510, y: 490 })
    expect(g.target).toEqual({ x: 540, y: 520, width: 90, height: 24 })
    expect(g.clip).toEqual({ x: 510, y: 490, width: 400, height: 160 })
    expect(g.viewClip).toEqual({ x: 310, y: 90, width: 1000, height: 700 })
    // Scrolled out of the frame's own viewport: not visible, though still inside the page.
    const out = guideGeometry({ ...base, target: { x: 30, y: 300, width: 90, height: 24 }, frame: { x: 200, y: 400, width: 400, height: 160 } })!
    expect(out.visible).toBe(false)
    // An iframe partly below the view: the clip is what is left of it.
    const low = guideGeometry({ ...base, target: { x: 30, y: 30, width: 90, height: 24 }, frame: { x: 200, y: 650, width: 400, height: 160 } })!
    expect(low.clip).toEqual({ x: 500, y: 730, width: 400, height: 50 })
    expect(low.visible).toBe(true)
  })

  it('clips to the visible part of the view and says when the target is out of sight', () => {
    // The card is half scrolled under the panel's top edge, and a docked panel covers its right 200 px.
    const clipped = { ...base, viewClip: { x: 300, y: 300, width: 800, height: 480 } }
    const hidden = guideGeometry(clipped)!
    expect(hidden.clip).toEqual({ x: 300, y: 300, width: 800, height: 480 })
    expect(hidden.visible).toBe(false)
    const seen = guideGeometry({ ...clipped, target: { x: 100, y: 300, width: 200, height: 40 } })!
    expect(seen.visible).toBe(true)
    // Half under the edge still counts: the overlay's own clip cuts the ring.
    expect(guideGeometry({ ...clipped, target: { x: 100, y: 200, width: 200, height: 40 } })!.visible).toBe(true)
    // Scrolled above the page, right of the view, or a view with no size: nothing to draw.
    expect(guideGeometry({ ...base, target: { x: 100, y: -90, width: 200, height: 40 } })!.visible).toBe(false)
    expect(guideGeometry({ ...base, target: { x: 1100, y: 50, width: 200, height: 40 } })!.visible).toBe(false)
    expect(guideGeometry({ ...base, viewClip: { x: 0, y: 0, width: 0, height: 0 } })!.visible).toBe(false)
    expect(guideGeometry({ ...base, view: { x: 0, y: 0, width: 0, height: 0 } })).toBeNull()
    expect(guideGeometry({ ...base, pageWidth: 0 })).toBeNull()
  })

  it('rect helpers: cover, local, intersect, page to screen', () => {
    expect(coverRect({ x: 10.4, y: 20.6, width: 100.2, height: 50 })).toEqual({ x: 10, y: 20, width: 101, height: 51 })
    expect(coverRect({ x: -10.4, y: -0.5, width: 5, height: 5 })).toEqual({ x: -11, y: -1, width: 6, height: 6 })
    expect(localRect({ x: 110, y: 220, width: 5, height: 6 }, { x: 100, y: 200 })).toEqual({ x: 10, y: 20, width: 5, height: 6 })
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 })).toMatchObject({ width: 0, height: 0 })
    expect(pageToScreen({ x: 10, y: 20, width: 30, height: 40 }, { x: 100, y: 200 }, 1.5)).toEqual({ x: 115, y: 230, width: 45, height: 60 })
  })
})
