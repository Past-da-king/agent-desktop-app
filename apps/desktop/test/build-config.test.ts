import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import config, { CORE } from '../electron.vite.config'

/**
 * 0.2.91 was packaged in a build copy whose node_modules/@agent/core linked to an older copy of the repo, so the
 * main process shipped that copy's settings defaults (no recordingAudioKeep: the setting could not be saved).
 * Every bundle must take this repo's own core by path.
 */
describe('the app bundles its own @agent/core', () => {
  const own = resolve(__dirname, '../../../packages/core/src/index.ts')
  const cfg = config as unknown as Record<'main' | 'preload' | 'renderer', { resolve?: { alias?: Record<string, string> } }>

  it('main and preload alias @agent/core to this repo by path', () => {
    expect(CORE).toBe(own)
    expect(existsSync(CORE)).toBe(true)
    expect(cfg.main.resolve?.alias?.['@agent/core']).toBe(own)
    expect(cfg.preload.resolve?.alias?.['@agent/core']).toBe(own)
  })

  it('the renderer takes the browser-safe entry of the same core', () => {
    expect(cfg.renderer.resolve?.alias?.['@agent/core']).toBe(join(own, '..', 'browser.ts'))
  })
})
