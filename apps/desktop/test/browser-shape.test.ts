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

  it('a fixed 1440 page fills the panel card top to bottom (no bands)', () => {
    const asked = resolveView(presetView('desktop'), { width: 1440, height: 900 })
    expect(asked.fixed).toBe(true)
    const shaped = shapedView(asked, panel)
    expect(shaped.width).toBe(1440)
    const fit = fitView(panel, shaped)
    expect(fit.bounds.width).toBe(470)
    expect(Math.abs(fit.bounds.height - 480)).toBeLessThanOrEqual(1)
  })

  it('a fixed 1440 page fills the full-size window edge to edge at 1:1 (no side bands)', () => {
    const asked = resolveView(presetView('desktop'), { width: 1440, height: 900 })
    const shaped = shapedView(asked, full)
    expect([shaped.width, shaped.height]).toEqual([1917, 950])
    expect(fitView(full, shaped).bounds).toEqual(full)
  })

  it('leaves phone and tablet at their device size', () => {
    expect(shapedView(presetView('phone'), full).width).toBe(390)
    expect(shapedView(presetView('tablet'), panel).height).toBe(1180)
  })

  it('switching back to plain desktop is shaped again', () => {
    const asked = resolveView(presetView('desktop'), { width: 1440, height: 900 })
    const phone = resolveView(asked, { mode: 'phone' })
    const back = resolveView(phone, { mode: 'desktop' })
    expect(shapedView(back, full).width).toBe(1917)
  })
})
