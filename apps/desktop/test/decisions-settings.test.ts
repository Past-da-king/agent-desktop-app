import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '@agent/core'

import { SettingsStore } from '../src/main/settings'
import { SETTINGS_NEED_APPROVAL } from '../src/main/tools/app-control'
import { READ_ONLY_TOOLS } from '../src/main/runtime/read-only'
import { ROW_BY_KEY } from '../src/renderer/views/settings/registry'

let dir: string
let store: SettingsStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dec-settings-'))
  store = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'pc' })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Decisions settings', () => {
  it('are off by default, with the Gemini backend and a 0.9 bar', () => {
    expect(DEFAULT_SETTINGS.decisionsEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.decisionsBackend).toBe('gemini')
    expect(DEFAULT_SETTINGS.decisionsThreshold).toBe(0.9)
    expect(store.get().decisionsEnabled).toBe(false)
  })
  it('save and read back, clamp the threshold and ignore an unknown backend', () => {
    store.save({ decisionsEnabled: true, decisionsBackend: 'openai', decisionsThreshold: 0.93 })
    expect(store.get()).toMatchObject({ decisionsEnabled: true, decisionsBackend: 'openai', decisionsThreshold: 0.93 })
    store.save({ decisionsThreshold: 5 })
    expect(store.get().decisionsThreshold).toBe(0.99)
    store.save({ decisionsThreshold: 0.01 })
    expect(store.get().decisionsThreshold).toBe(0.5)
    store.save({ decisionsBackend: 'nonsense' as never })
    expect(store.get().decisionsBackend).toBe('openai')
    store.save({ decisionsThreshold: 'x' as never })
    expect(store.get().decisionsThreshold).toBe(0.5)
  })
  it('have Settings rows, need his yes when an agent changes them, and decide is a read tool', () => {
    for (const key of ['decisionsEnabled', 'decisionsBackend', 'decisionsThreshold']) {
      expect(ROW_BY_KEY[key]?.section).toBe('agents')
      expect(SETTINGS_NEED_APPROVAL.has(key)).toBe(true)
    }
    expect(READ_ONLY_TOOLS.has('decide')).toBe(true)
  })
})
