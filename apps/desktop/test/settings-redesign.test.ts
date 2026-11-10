/**
 * The Settings redesign (4 Nov 2026): every key in DEFAULT_SETTINGS has one row with a real control, every row's
 * value survives the save and the next load, an older settings file keeps every value, the Developer switch hides the
 * two developer sections from the rail and nothing from the search box.
 *
 * The save path here is the one the window uses: the renderer calls agent.settings.save(patch), the preload passes it
 * over the settings channel, and SettingsStore.save applies it. This test drives SettingsStore directly (the same
 * store, the same coercion) and then reads the file back with a fresh store, which is exactly what a restart does.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type Settings } from '@agent/core'

import { SettingsStore } from '../src/main/settings'
import { DEFAULT_SECTION, SettingsRail } from '../src/renderer/views/settings/Rail'
import { ROWS, ROW_BY_KEY, SECTIONS, isDefault, railSections, rowsOfSection, searchSettings, visibleRows } from '../src/renderer/views/settings/registry'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-redesign-'))
  dirs.push(dir)
  return join(dir, 'settings.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const store = (file: string): SettingsStore => new SettingsStore(file, { hostname: () => 'test-machine' })

/** The settings keys, from the one place they are defined. */
const KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>

/** Every row's sample value, as one patch, accounts first so the AI picks have an account to point at. */
function allSamples(): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const row of ROWS) {
    if (row.key === 'ai') continue
    patch[row.key] = row.sample
  }
  patch['ai'] = ROW_BY_KEY['ai']!.sample
  return patch
}

describe('the settings rows are the settings', () => {
  it('has exactly one row for every key in DEFAULT_SETTINGS, and no row for anything else', () => {
    expect(ROWS.map((row) => row.key).sort()).toEqual([...KEYS].sort())
    expect(new Set(ROWS.map((row) => row.key)).size).toBe(ROWS.length)
    expect(ROWS.every((row) => row.label.trim() !== '' && row.description.trim() !== '')).toBe(true)
  })

  it('keeps the ten sections in the agreed order with the agreed counts', () => {
    expect(SECTIONS.map((section) => section.name)).toEqual([
      'Account and AI',
      'Profiles and connections',
      'Devices',
      'Agents and helpers',
      'Voice and dictation',
      'Notifications and wake-ups',
      'Appearance',
      'Privacy and data',
      'Git and developer',
      'Advanced',
    ])
    expect(rowsOfSection('account')).toHaveLength(6)
    expect(rowsOfSection('profiles')).toHaveLength(0)
    expect(rowsOfSection('devices')).toHaveLength(4)
    expect(rowsOfSection('agents')).toHaveLength(12)
    expect(rowsOfSection('voice')).toHaveLength(5)
    expect(rowsOfSection('notify')).toHaveLength(8)
    expect(rowsOfSection('appearance')).toHaveLength(4)
    expect(rowsOfSection('privacy')).toHaveLength(6)
    expect(rowsOfSection('git')).toHaveLength(4)
    expect(rowsOfSection('advanced')).toHaveLength(14)
  })

  it('gives the eight keys that had no control a control, and names them in plain words', () => {
    for (const key of ['dailyMemoryAt', 'miniappPinCap', 'devicesPreferred', 'helperBusyCpu', 'watchdogMs', 'deviceName', 'agentName', 'userName']) {
      expect(ROW_BY_KEY[key]!.control).not.toBe('readonly')
      expect(ROW_BY_KEY[key]!.control).not.toBe('block')
    }
    // Nothing is labelled with the name only the code uses.
    expect(ROW_BY_KEY['watchdogMs']!.label).toBe('Log a frozen main thread')
    expect(ROW_BY_KEY['helperBusyCpu']!.label).toBe('Send work elsewhere when this computer is busy')
  })

  it('writes no em dash and no emoji in a label or a description', () => {
    for (const row of ROWS) {
      for (const text of [row.label, row.description]) {
        expect(text.includes('\u2014')).toBe(false)
        expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)).toBe(false)
      }
    }
  })
})

describe('every setting saves and comes back', () => {
  for (const row of ROWS) {
    it(`${row.key}: ${row.label}`, () => {
      const file = tempFile()
      const first = store(file)
      // The AI picks point at an account, so the account has to exist first (that is what the page does too).
      if (row.key === 'ai') first.save({ accounts: ROW_BY_KEY['accounts']!.sample } as Partial<Settings>)
      const saved = first.save({ [row.key]: row.sample } as Partial<Settings>) as unknown as Record<string, unknown>
      const value = saved[row.key]
      // It is a real change, not the default written back.
      expect(isDefault(row, value)).toBe(false)
      // A restart reads the same value back from the same file.
      const restarted = store(file).get() as unknown as Record<string, unknown>
      expect(restarted[row.key]).toEqual(value)
    })
  }
})

describe('an older settings file keeps every value', () => {
  it('loads all 58 keys intact, including a file written before the new key existed', () => {
    const before = tempFile()
    const written = store(before).save(allSamples() as Partial<Settings>) as unknown as Record<string, unknown>

    // The file an install had before the redesign: every key, and no showDeveloperSettings at all.
    const older = tempFile()
    const file = { ...written }
    delete file['showDeveloperSettings']
    writeFileSync(older, JSON.stringify(file, null, 2))

    const loaded = store(older).get() as unknown as Record<string, unknown>
    // The old single-choice fields mirror the account (mirrorAccounts in main/settings.ts): saving an API account
    // writes them, so they are compared for being kept, not for being away from their own default.
    const MIRRORED = ['mode', 'cli', 'cliModel', 'provider', 'model', 'hasKey', 'baseUrl', 'allowHttp']
    for (const key of KEYS) {
      if (key === 'showDeveloperSettings') continue
      expect(loaded[key], key).toEqual(written[key])
      if (MIRRORED.includes(key)) continue
      expect(isDefault(ROW_BY_KEY[key]!, loaded[key]), key).toBe(false)
    }
    expect(loaded['showDeveloperSettings']).toBe(false)
    // Nothing was renamed or lost: the file still holds every key it held.
    const onDisk = JSON.parse(readFileSync(older, 'utf8')) as Record<string, unknown>
    expect(Object.keys(onDisk).sort()).toEqual(KEYS.filter((key) => key !== 'showDeveloperSettings').sort())
  })
})

describe('the developer switch', () => {
  it('is off by default and is a plain setting, not one that asks', () => {
    expect(DEFAULT_SETTINGS.showDeveloperSettings).toBe(false)
    expect(ROW_BY_KEY['showDeveloperSettings']!.control).toBe('switch')
  })

  it('hides Git and developer and Advanced from the rail while it is off, and shows them when it is on', () => {
    const off = railSections(false).map((item) => item.section.name)
    expect(off).not.toContain('Git and developer')
    expect(off).not.toContain('Advanced')
    expect(off).toHaveLength(8)

    const on = railSections(true).map((item) => item.section.name)
    expect(on).toContain('Git and developer')
    expect(on).toContain('Advanced')
    expect(on).toHaveLength(10)

    expect(visibleRows(false).some((row) => row.section === 'git' || row.section === 'advanced')).toBe(false)
    expect(visibleRows(true)).toHaveLength(ROWS.length)
  })

  it('draws the rail with the counts, and without the hidden sections', () => {
    const html = renderToStaticMarkup(
      createElement(SettingsRail, { sections: railSections(false), current: DEFAULT_SECTION, onPick: () => undefined }),
    )
    // The section names in the rail, not the whole markup: the foot says in words which two sections the switch adds.
    // The rail lists no HIDDEN badge: a section it lists is a section you can open.
    const labels = [...html.matchAll(/<span class="lbl">([^<]+)<\/span>/g)].map((match) => match[1])
    expect(labels).toContain('Appearance')
    expect(labels).toContain('Notifications and wake-ups')
    expect(labels).not.toContain('Git and developer')
    expect(labels).not.toContain('Advanced')
    expect(html).toContain('aria-current="true"')
    // The one line that says what the page does with a change.
    expect(html).toContain('Everything saves as you change it.')

    const all = renderToStaticMarkup(
      createElement(SettingsRail, { sections: railSections(true), current: 'advanced', onPick: () => undefined }),
    )
    expect(all).toContain('Git and developer')
    expect(all).toContain('Advanced')
  })
})

describe('the search box', () => {
  it('finds a setting by its label, and says which section it is in', () => {
    const hits = searchSettings('quiet hours')
    const quiet = hits.find((hit) => hit.row.key === 'wakeupQuietHours')
    expect(quiet).toBeDefined()
    expect(quiet!.section.name).toBe('Notifications and wake-ups')
    expect(quiet!.hidden).toBe(false)
  })

  it('finds a setting by words in its description, not only its name', () => {
    const busy = searchSettings('processor use').find((hit) => hit.row.key === 'helperBusyCpu')
    expect(busy).toBeDefined()
    expect(busy!.section.name).toBe('Agents and helpers')
    // A word a person would use for the same thing.
    expect(searchSettings('cpu').some((hit) => hit.row.key === 'helperBusyCpu')).toBe(true)
    expect(searchSettings('shortcut').length).toBeGreaterThanOrEqual(3)
  })

  it('finds a hidden setting by its section name and marks it hidden', () => {
    const hits = searchSettings('git', false)
    const commit = hits.find((hit) => hit.row.key === 'gitAutoCommit')
    expect(commit).toBeDefined()
    expect(commit!.hidden).toBe(true)
    expect(commit!.section.name).toBe('Git and developer')
    // The same search with the switch on is not hidden any more.
    expect(searchSettings('git', true).find((hit) => hit.row.key === 'gitAutoCommit')!.hidden).toBe(false)
  })

  it('finds a hidden setting by its key name, and finds nothing for an empty box', () => {
    const hit = searchSettings('watchdogMs').find((item) => item.row.key === 'watchdogMs')
    expect(hit).toBeDefined()
    expect(hit!.hidden).toBe(true)
    expect(searchSettings('   ')).toEqual([])
    // Every hit carries its own section, so the result can be labelled with it.
    for (const item of searchSettings('key')) expect(item.section.id).toBe(item.row.section)
  })
})

describe('reset settings only', () => {
  it('puts every setting back to its default and keeps this computer a name', () => {
    const file = tempFile()
    const first = store(file)
    first.save(allSamples() as Partial<Settings>)
    const reset = first.resetSettings()
    expect(reset.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(reset.shell).toBe(DEFAULT_SETTINGS.shell)
    expect(reset.accounts).toEqual([])
    expect(reset.grantedFolders).toEqual([])
    expect(reset.showDeveloperSettings).toBe(false)
    expect(reset.deviceName).toBe('test-machine')
    // The file on disk says the same, so a restart is still reset.
    expect(store(file).get().theme).toBe(DEFAULT_SETTINGS.theme)
  })
})
