import { describe, expect, it } from 'vitest'

import {
  emulationCommands,
  fitView,
  parseAspect,
  presetView,
  resolveView,
  userAgentFor,
  customUserAgentMetadata,
  truthfulUserAgent,
  isOwnDesktopUserAgent,
  userAgentMetadata,
  viewLabel,
  viewModeOf,
} from '../src/main/browser/emulation'

const engine = { chromeVersion: '152.0.7977.167', platform: 'linux' }
const slot = { x: 100, y: 200, width: 400, height: 300 }

describe('browser emulation', () => {
  it('draws a 1440x900 desktop page scaled down to fit the panel, centred', () => {
    const fit = fitView(slot, presetView('desktop'))
    expect(fit.scale).toBeCloseTo(400 / 1440, 5)
    expect(fit.bounds.width).toBe(400)
    expect(fit.bounds.height).toBe(250)
    expect(fit.bounds.x).toBe(100)
    expect(fit.bounds.y).toBe(200 + 25)
  })

  it('letterboxes a phone by height, with bars at the sides', () => {
    const fit = fitView(slot, presetView('phone'))
    expect(fit.scale).toBeCloseTo(300 / 844, 5)
    expect(fit.bounds.height).toBe(300)
    expect(fit.bounds.width).toBe(Math.round(390 * (300 / 844)))
    expect(fit.bounds.x).toBeGreaterThan(slot.x + 100)
  })

  it('never scales a page up and gives fit mode the whole slot', () => {
    const small = resolveView(presetView('desktop'), { width: 320, height: 240 })
    expect(fitView({ x: 0, y: 0, width: 1000, height: 800 }, small).scale).toBe(1)
    const fit = fitView(slot, presetView('fit'))
    expect(fit.bounds).toEqual(slot)
    expect(fit.scale).toBe(1)
  })

  it('starts a new mode from its preset, takes sizes and aspect ratios, and clamps nonsense', () => {
    const phone = resolveView(presetView('desktop'), { mode: 'phone' })
    expect([phone.width, phone.height, phone.dpr, phone.touch, phone.mobile]).toEqual([390, 844, 3, true, true])
    const wide = resolveView(presetView('desktop'), { width: 1920, aspect: '16:9' })
    expect(wide.height).toBe(1080)
    const huge = resolveView(presetView('desktop'), { width: 100000, height: 5, zoom: 99 })
    expect([huge.width, huge.height, huge.zoom]).toEqual([4000, 200, 3])
    expect(parseAspect('9x16')).toBeCloseTo(0.5625, 4)
    expect(parseAspect('wide')).toBeNull()
  })

  it('presents a phone with a mobile Android user agent and matching client hints', () => {
    const phone = presetView('phone')
    const ua = userAgentFor(phone, engine)
    expect(ua).toContain('Android')
    expect(ua).toContain('Mobile Safari')
    expect(ua).toContain('Chrome/152.0.7977.167')
    const hints = userAgentMetadata(phone, engine)
    expect(hints['mobile']).toBe(true)
    expect(hints['platform']).toBe('Android')
  })

  it('presents a desktop as Chrome on this computer, with no Electron or app token', () => {
    const ua = userAgentFor(presetView('desktop'), engine)
    expect(ua).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.167 Safari/537.36')
    expect(userAgentFor(presetView('desktop'), { ...engine, platform: 'win32' })).toContain('Windows NT 10.0')
    const brands = userAgentMetadata(presetView('desktop'), engine)['brands'] as Array<{ brand: string }>
    expect(brands.map((b) => b.brand)).toContain('Google Chrome')
  })

  it('builds the CDP commands: metrics with the draw scale, touch for phones, a clear for fit', () => {
    const phone = presetView('phone')
    const commands = emulationCommands(phone, engine, { bounds: slot, scale: 0.4 })
    const metrics = commands.find((c) => c.method === 'Emulation.setDeviceMetricsOverride')
    expect(metrics?.params).toMatchObject({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true, scale: 0.4 })
    expect(commands.find((c) => c.method === 'Emulation.setTouchEmulationEnabled')?.params['enabled']).toBe(true)
    const fit = emulationCommands(presetView('fit'), engine, { bounds: slot, scale: 1 })
    expect(fit.some((c) => c.method === 'Emulation.clearDeviceMetricsOverride')).toBe(true)
    const custom = emulationCommands(resolveView(presetView('desktop'), { userAgent: 'Custom/1.0' }), engine, { bounds: slot, scale: 1 })
    const override = custom.find((c) => c.method === 'Emulation.setUserAgentOverride')
    expect(override?.params['userAgent']).toBe('Custom/1.0')
    expect(override?.params['userAgentMetadata']).toBeUndefined()
  })

  it('never lets a hand-written Chrome user agent claim another engine version, and always gives it matching hints', () => {
    // 23 Oct 2026: a saved Chrome/141 user agent on a 152 engine with empty client hints got X's Continue with
    // Google refused ("An unexpected error occurred"); the engine's own identity signs in.
    const stale = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
    const view = resolveView(presetView('desktop'), { userAgent: stale })
    expect(userAgentFor(view, engine)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.167 Safari/537.36')
    const override = emulationCommands(view, engine, { bounds: slot, scale: 1 }).find((c) => c.method === 'Emulation.setUserAgentOverride')
    expect(override?.params['userAgent']).toContain('Chrome/152.0.7977.167')
    const hints = override?.params['userAgentMetadata'] as Record<string, unknown>
    expect(hints['platform']).toBe('Windows')
    expect(hints['mobile']).toBe(false)
    expect((hints['brands'] as Array<{ brand: string; version: string }>).find((b) => b.brand === 'Google Chrome')?.version).toBe('152')
    expect(override?.params['platform']).toBe('Win32')
    // A hand-written Android Chrome agrees with itself too.
    const android = customUserAgentMetadata('Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', engine)
    expect(android).toMatchObject({ platform: 'Android', mobile: true, model: 'SM-G991B' })
    expect(customUserAgentMetadata('Custom/1.0', engine)).toBeNull()
    expect(truthfulUserAgent('Custom/1.0', engine)).toBe('Custom/1.0')
    expect(isOwnDesktopUserAgent(stale, 'win32')).toBe(true)
    expect(isOwnDesktopUserAgent(stale, 'darwin')).toBe(false)
  })

  it('names views plainly and understands the words models use', () => {
    expect(viewLabel(presetView('desktop'))).toBe('Desktop 1440x900')
    expect(viewLabel(resolveView(presetView('phone'), { zoom: 0.8 }))).toBe('Phone 390x844 at 80%')
    expect(viewModeOf('mobile')).toBe('phone')
    expect(viewModeOf('iPad')).toBe('tablet')
    expect(viewModeOf('laptop')).toBe('desktop')
    expect(viewModeOf('watch')).toBeNull()
  })
})
