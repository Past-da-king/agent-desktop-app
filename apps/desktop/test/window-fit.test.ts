import { describe, expect, it } from 'vitest'

import { fitWindowToDisplay, looksSnapped, type FittedWindow, type Rect } from '../src/main/window-fit'
import { quickAskPosition, QUICK_ASK_HEIGHT, QUICK_ASK_WIDTH } from '../src/main/hotkey'
import { pillBounds } from '../src/main/dictation/pill'

const OPTIONS = { minWidth: 360, minHeight: 600, defaultWidth: 1280, defaultHeight: 820 }

function inside(rect: FittedWindow | Rect, area: Rect): boolean {
  return (
    rect.x !== null &&
    rect.y !== null &&
    rect.x >= area.x &&
    rect.y >= area.y &&
    rect.x + rect.width <= area.x + area.width &&
    rect.y + rect.height <= area.y + area.height
  )
}

// One 1536x864 screen (1920x1080 at 125%), with and without the taskbar taken off.
const LAPTOP: Rect = { x: 0, y: 0, width: 1536, height: 864 }
const LAPTOP_TASKBAR: Rect = { x: 0, y: 0, width: 1536, height: 816 }
const LEFT_MONITOR: Rect = { x: -1920, y: 0, width: 1920, height: 1040 }
const RIGHT_MONITOR: Rect = { x: 1536, y: 0, width: 1920, height: 1040 }

describe('fitWindowToDisplay', () => {
  it('pulls his saved window (wider than the screen, bottom below it) fully onto a 1536x864 screen', () => {
    const saved = { width: 1538, height: 635, x: 3, y: 235, maximized: false }
    for (const area of [LAPTOP, LAPTOP_TASKBAR]) {
      const fit = fitWindowToDisplay(saved, [area], OPTIONS)
      expect(inside(fit, area)).toBe(true)
      expect(fit.width).toBe(1536)
      expect(fit.height).toBe(635)
      expect(fit.x).toBe(0)
      // Centred top to bottom, not left hanging a third of the way down.
      expect(fit.y).toBe(Math.round((area.height - 635) / 2))
      expect(fit.maximized).toBe(false)
    }
  })

  it('brings a window back from a second monitor that is gone, centred on the primary', () => {
    const saved = { width: 1200, height: 800, x: 1800, y: 100, maximized: false }
    const fit = fitWindowToDisplay(saved, [LAPTOP_TASKBAR], OPTIONS)
    expect(inside(fit, LAPTOP_TASKBAR)).toBe(true)
    expect(fit).toEqual({ x: 168, y: 8, width: 1200, height: 800, maximized: false })
  })

  it('keeps negative coordinates on a left-hand monitor that is still there', () => {
    const saved = { width: 1200, height: 800, x: -1700, y: 120, maximized: false }
    const fit = fitWindowToDisplay(saved, [LAPTOP_TASKBAR, LEFT_MONITOR], OPTIONS)
    expect(fit).toEqual({ x: -1700, y: 120, width: 1200, height: 800, maximized: false })
  })

  it('moves the same window to the primary when the left-hand monitor is unplugged', () => {
    const saved = { width: 1200, height: 800, x: -1700, y: 120, maximized: false }
    const fit = fitWindowToDisplay(saved, [LAPTOP_TASKBAR], OPTIONS)
    expect(inside(fit, LAPTOP_TASKBAR)).toBe(true)
  })

  it('puts a window that straddles two monitors on the one holding most of it, fully', () => {
    const saved = { width: 1200, height: 800, x: 1000, y: 50, maximized: false }
    const fit = fitWindowToDisplay(saved, [LAPTOP_TASKBAR, RIGHT_MONITOR], OPTIONS)
    expect(inside(fit, RIGHT_MONITOR)).toBe(true)
  })

  it('shrinks a window bigger than the screen to fit it', () => {
    const saved = { width: 2400, height: 700, x: 50, y: 50, maximized: false }
    const fit = fitWindowToDisplay(saved, [LAPTOP_TASKBAR], OPTIONS)
    expect(inside(fit, LAPTOP_TASKBAR)).toBe(true)
    expect(fit.width).toBe(1536)
    expect(fit.height).toBe(700)
    expect(fit.maximized).toBe(false)
  })

  it('opens maximised when it was maximised, or saved as big as the screen both ways', () => {
    const maxed = fitWindowToDisplay({ width: 1000, height: 700, x: 100, y: 50, maximized: true }, [LAPTOP_TASKBAR], OPTIONS)
    expect(maxed).toEqual({ x: 100, y: 50, width: 1000, height: 700, maximized: true })

    const huge = fitWindowToDisplay({ width: 1550, height: 830, x: -7, y: -7, maximized: false }, [LAPTOP_TASKBAR], OPTIONS)
    expect(huge.maximized).toBe(true)
    // What it returns to when un-maximised is a real window, not the whole screen again.
    expect(inside(huge, LAPTOP_TASKBAR)).toBe(true)
    expect(huge.width).toBeLessThan(1536)
    expect(huge.height).toBeLessThan(816)
  })

  it('never maximises when re-fitting a live window', () => {
    const fit = fitWindowToDisplay(
      { width: 1550, height: 830, x: -7, y: -7, maximized: false },
      [LAPTOP_TASKBAR],
      { ...OPTIONS, allowMaximize: false },
    )
    expect(fit.maximized).toBe(false)
    expect(inside(fit, LAPTOP_TASKBAR)).toBe(true)
  })

  it('leaves a fully valid window exactly as it was', () => {
    const saved = { width: 1100, height: 700, x: 120, y: 40, maximized: false }
    expect(fitWindowToDisplay(saved, [LAPTOP_TASKBAR, LEFT_MONITOR], OPTIONS)).toEqual(saved)
    const left = { width: 1600, height: 900, x: -1800, y: 20, maximized: false }
    expect(fitWindowToDisplay(left, [LAPTOP_TASKBAR, LEFT_MONITOR], OPTIONS)).toEqual(left)
  })

  it('gives a window below the minimum size, or never placed, the default size centred', () => {
    const tiny = fitWindowToDisplay({ width: 100, height: 80, x: 10, y: 10, maximized: false }, [LAPTOP_TASKBAR], OPTIONS)
    expect(tiny.width).toBe(1280)
    expect(tiny.height).toBe(816)
    expect(inside(tiny, LAPTOP_TASKBAR)).toBe(true)

    const fresh = fitWindowToDisplay({ width: 1280, height: 820, x: null, y: null, maximized: false }, [LAPTOP_TASKBAR], OPTIONS)
    expect(inside(fresh, LAPTOP_TASKBAR)).toBe(true)
    expect(fresh.x).toBe(128)
  })

  it('treats a window barely on any screen as lost and centres it', () => {
    const saved = { width: 1200, height: 700, x: 1500, y: 700, maximized: false }
    const fit = fitWindowToDisplay(saved, [LAPTOP_TASKBAR], OPTIONS)
    expect(fit).toEqual({ x: 168, y: 58, width: 1200, height: 700, maximized: false })
  })
})

describe('looksSnapped', () => {
  it('sees left and right halves and quarters, not a window he placed or the whole screen', () => {
    expect(looksSnapped({ x: 0, y: 0, width: 768, height: 816 }, LAPTOP_TASKBAR)).toBe(true)
    expect(looksSnapped({ x: 768, y: 0, width: 768, height: 816 }, LAPTOP_TASKBAR)).toBe(true)
    expect(looksSnapped({ x: 0, y: 408, width: 768, height: 408 }, LAPTOP_TASKBAR)).toBe(true)
    expect(looksSnapped({ x: 120, y: 40, width: 1100, height: 700 }, LAPTOP_TASKBAR)).toBe(false)
    expect(looksSnapped({ x: 0, y: 0, width: 1536, height: 816 }, LAPTOP_TASKBAR)).toBe(false)
  })
})

describe('quick ask and dictation pill stay on a small screen', () => {
  const narrow: Rect = { x: 100, y: 0, width: 480, height: 800 }

  it('quick ask never starts left of the screen it opens on', () => {
    const { x, y } = quickAskPosition(narrow)
    expect(x).toBeGreaterThanOrEqual(narrow.x)
    expect(y + QUICK_ASK_HEIGHT).toBeLessThanOrEqual(narrow.y + narrow.height)
    expect(quickAskPosition(LAPTOP_TASKBAR).x).toBe(Math.round((1536 - QUICK_ASK_WIDTH) / 2))
  })

  it('the pill fits a narrow screen', () => {
    const pill = pillBounds(narrow)
    expect(inside(pill, narrow)).toBe(true)
  })
})
