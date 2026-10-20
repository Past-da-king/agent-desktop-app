/** A plain desktop page takes the shape of where it is shown, so the panel and the full screen are filled. */
import { describe, expect, it } from 'vitest'

import { fitView, presetView, resolveView, shapedView } from '../src/main/browser/emulation'

const panel = { x: 0, y: 0, width: 470, height: 480 }
const full = { x: 0, y: 60, width: 1917, height: 950 }

describe('shaped desktop view', () => {
  it('renders 1:1 at the full-screen size', () => {
    const view = shapedView(presetView('desktop'), full)
    expect([view.width, view.height]).toEqual([1917, 950])
    expect(fitView(full, view).scale).toBe(1)
    expect(fitView(full, view).bounds).toEqual(full)
  })

  it('keeps a desktop width in the small panel and takes its height, so nothing is left empty', () => {
    const view = shapedView(presetView('desktop'), panel)
    expect(view.width).toBe(1440)
    expect(view.height).toBe(Math.round((1440 * 480) / 470))
    const fit = fitView(panel, view)
    expect(fit.bounds.width).toBe(470)
    expect(Math.abs(fit.bounds.height - 480)).toBeLessThanOrEqual(1)
  })

  it('leaves an exact size the agent asked for alone', () => {
    const asked = resolveView(presetView('desktop'), { width: 1440, height: 900 })
    expect(asked.fixed).toBe(true)
    expect([shapedView(asked, full).width, shapedView(asked, full).height]).toEqual([1440, 900])
  })

  it('leaves phone and tablet at their device size', () => {
    expect(shapedView(presetView('phone'), full).width).toBe(390)
    expect(shapedView(presetView('tablet'), panel).height).toBe(1180)
  })

  it('switching back to plain desktop is shaped again', () => {
    const asked = resolveView(presetView('desktop'), { width: 1440, height: 900 })
    const phone = resolveView(asked, { mode: 'phone' })
    const back = resolveView(phone, { mode: 'desktop' })
    expect(back.fixed).toBe(false)
    expect(shapedView(back, full).width).toBe(1917)
  })
})
