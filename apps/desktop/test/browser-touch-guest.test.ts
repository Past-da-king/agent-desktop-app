import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A real Electron <webview> guest with a cross-site iframe, on an engine told it has a touchscreen. Skipped where
 * Electron cannot open a window (needs a display: xvfb-run on a server).
 */
const fixture = fileURLToPath(new URL('./fixtures/no-touch-guest.cjs', import.meta.url))
const source = fileURLToPath(new URL('../src/main/browser/touch-profile.ts', import.meta.url))

interface Report {
  maxTouchPoints: number
  ontouchstart: boolean
  pointerCoarse: boolean
  pointerFine: boolean
  anyPointerFine: boolean
  hoverHover: boolean
  anyHoverHover: boolean
}
interface Result {
  case: string
  top: Report
  frames: number
  frame: Report | null
}

let electron: string | null = null
try {
  electron = createRequire(import.meta.url)('electron') as string
} catch {
  electron = null
}
const display = process.platform === 'win32' || process.env['DISPLAY'] !== undefined
const runnable = electron !== null && existsSync(electron) && display && process.env['AGENT_GUEST_TESTS'] !== '0'

describe.skipIf(!runnable)('the guest page, on an engine with a touchscreen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-touch-'))
  const results = new Map<string, Result>()

  beforeAll(async () => {
    const bundle = join(dir, 'touch-profile.cjs')
    await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' })
    // One Electron per case: a fresh engine each time, as a fresh tab is.
    for (const name of ['off', 'desktop', 'phone']) {
      const out = spawnSync(electron as string, ['--no-sandbox', fixture], {
        env: { ...process.env, TOUCH_PROFILE_BUNDLE: bundle, CASES: name },
        encoding: 'utf8',
        timeout: 60_000,
      })
      for (const line of (out.stdout ?? '').split('\n')) {
        if (line.startsWith('FAIL')) throw new Error(`${name}: ${line}`)
        if (line.startsWith('RESULT ')) {
          const r = JSON.parse(line.slice(7)) as Result
          results.set(r.case, r)
        }
      }
    }
  }, 130_000)

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('red: without the profile the page and the frame still show the touchscreen', () => {
    const off = results.get('off')
    expect(off?.frames).toBe(1)
    expect(off?.top.ontouchstart).toBe(true)
    expect(off?.frame?.ontouchstart).toBe(true)
  })

  it('green: desktop reports no touch and a fine, hovering pointer in the page and the cross-site frame', () => {
    const desktop = results.get('desktop')
    expect(desktop?.frames).toBe(1)
    for (const seen of [desktop?.top, desktop?.frame]) {
      expect(seen?.maxTouchPoints).toBe(0)
      expect(seen?.ontouchstart).toBe(false)
      expect(seen?.pointerCoarse).toBe(false)
      expect(seen?.pointerFine).toBe(true)
      expect(seen?.anyPointerFine).toBe(true)
      expect(seen?.hoverHover).toBe(true)
      expect(seen?.anyHoverHover).toBe(true)
    }
  })

  it('phone mode still emulates touch in the page', () => {
    const phone = results.get('phone')
    expect(phone?.top.maxTouchPoints).toBe(5)
    expect(phone?.top.ontouchstart).toBe(true)
    expect(phone?.top.pointerCoarse).toBe(true)
    expect(phone?.top.hoverHover).toBe(false)
  })
})
