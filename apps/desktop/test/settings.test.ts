import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type ThemePref } from '@agent/core'

import { SettingsStore, removeStaleTemp } from '../src/main/settings'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-'))
  dirs.push(dir)
  return join(dir, 'settings.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  it('starts from the defaults and fixes a device name', () => {
    const file = tempFile()
    const store = new SettingsStore(file, { hostname: () => 'test-machine' })
    const settings = store.get()

    expect(settings).toEqual({ ...DEFAULT_SETTINGS, deviceName: 'test-machine' })
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ deviceName: 'test-machine' })
  })

  it('merges saved values over the defaults', () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        theme: 'dark',
        userName: 'Sam',
        grantedFolders: ['/tmp/one'],
        deviceName: 'kept-name',
      }),
    )
    const store = new SettingsStore(file, { hostname: () => 'test-machine' })

    expect(store.get()).toMatchObject({
      theme: 'dark',
      userName: 'Sam',
      grantedFolders: ['/tmp/one'],
      deviceName: 'kept-name',
      agentName: DEFAULT_SETTINGS.agentName,
      shell: 'ask',
    })
  })

  it('ignores invalid values, unknown keys and clamps long strings', () => {
    const file = tempFile()
    const store = new SettingsStore(file, { hostname: () => 'test-machine' })

    store.save({
      theme: 12 as unknown as ThemePref,
      provider: 'not-a-provider' as never,
      userName: 'x'.repeat(900),
      unknown: 'ignored',
    } as never)

    const settings = store.get()
    expect(settings.theme).toBe('system')
    expect(settings.provider).toBe('anthropic')
    expect(settings.userName).toHaveLength(500)
    expect('unknown' in settings).toBe(false)
  })

  it('accepts a valid patch and notifies listeners', () => {
    const store = new SettingsStore(tempFile(), { hostname: () => 'test-machine' })
    let seen = 0
    const off = store.onChange(() => {
      seen++
    })

    const saved = store.save({ theme: 'light', grantedFolders: ['/home/me/notes'] })
    expect(saved.theme).toBe('light')
    expect(saved.grantedFolders).toEqual(['/home/me/notes'])
    expect(seen).toBe(1)

    off()
    store.save({ theme: 'dark' })
    expect(seen).toBe(1)
  })

  it('writes atomically and survives a stale temp file', () => {
    const file = tempFile()
    const store = new SettingsStore(file, { hostname: () => 'test-machine' })
    writeFileSync(`${file}.tmp`, '{ this is a half-written crash')

    store.save({ userName: 'Survivor' })

    expect(store.get().userName).toBe('Survivor')
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow()

    removeStaleTemp(file)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('resets to defaults and keeps the device name', () => {
    const store = new SettingsStore(tempFile(), { hostname: () => 'test-machine' })
    store.save({ userName: 'Sam', theme: 'dark', onboarded: true })

    const reset = store.reset()
    expect(reset.userName).toBe('')
    expect(reset.theme).toBe('system')
    expect(reset.onboarded).toBe(false)
    expect(reset.deviceName).toBe('test-machine')
  })
})
